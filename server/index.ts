// Server half of the PC Health app. Runs in Node inside DeskThing on the PC.
//
// Data source: the newest report written by PC Health Checker to
//   C:\Apps\Portable\PC Health\PCHealth-data\history\health-<stamp>.json
// Those reports are generated on a schedule, so this polls the directory for a
// newer file rather than re-running any checks itself.

import { createDeskThing } from "@deskthing/server";
import { AppSettings, DESKTHING_EVENTS, SETTING_TYPES } from "@deskthing/types";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  CLIENT_TYPE,
  SERVER_TYPE,
  CategoryStatus,
  CategoryMetrics,
  HealthCategory,
  HealthDelta,
  HealthPayload,
  StatusChange,
  HealthReport,
  ToClientData,
  ToServerData,
} from "../shared/transit";

const DeskThing = createDeskThing<ToServerData, ToClientData>();

const DEFAULT_DIR = "C:\\Apps\\Portable\\PC Health\\PCHealth-data\\history";

const SETTING_IDS = {
  DIR: "history_dir",
  INTERVAL: "refresh_interval",
} as const;

const DEFAULTS = { dir: DEFAULT_DIR, interval: 60 };

// Settings are cached and only ever updated by the SETTINGS event. Reading them
// from the poll path caused a re-entrant loop in the sibling app that stacked
// intervals until the process ran out of file descriptors.
let cfg = { ...DEFAULTS };
let cancelPoll: (() => void) | null = null;
let armedIntervalMs = 0;
let lastSerialized = "";
let reading = false;

const VALID: CategoryStatus[] = ["OK", "INFO", "WARN", "CRIT"];

/**
 * The two newest health-*.json files by mtime, newest first.
 *
 * The second one is what makes the "since last scan" line possible. Sorting the
 * whole list is fine here - the directory holds tens of files, not thousands,
 * and it is read once per poll.
 */
const newestReportPaths = async (dir: string): Promise<string[]> => {
  const names = (await readdir(dir)).filter(
    (n) => n.startsWith("health-") && n.endsWith(".json")
  );
  const stamped: { path: string; mtime: number }[] = [];
  for (const n of names) {
    const p = join(dir, n);
    try {
      const st = await stat(p);
      stamped.push({ path: p, mtime: st.mtimeMs });
    } catch {
      /* skip unreadable */
    }
  }
  stamped.sort((a, b) => b.mtime - a.mtime);
  return stamped.slice(0, 2).map((x) => x.path);
};

/** Parse one health-*.json into a HealthReport. */
const parseReport = async (path: string): Promise<HealthReport> => {
  // PC Health Checker writes these with a UTF-8 BOM (it is a PowerShell
  // script). JSON.parse rejects a leading U+FEFF outright, so strip it.
  const text = (await readFile(path, "utf-8")).replace(/^﻿/, "");
  const parsed = JSON.parse(text);

  const categories: HealthCategory[] = (parsed.categories ?? []).map(
    (c: Record<string, unknown>) => ({
      name: String(c.Name ?? "Unknown"),
      status: (VALID.includes(c.Status as CategoryStatus)
        ? c.Status
        : "INFO") as CategoryStatus,
      penalty: Number(c.Penalty ?? 0),
      details: Array.isArray(c.Details) ? (c.Details as string[]) : [],
      // Pass the whole bag through untouched. Its shape varies by category and
      // the client picks out what it can draw; dropping it here is what left
      // the screen with nothing but prose to render.
      metrics: (c.Metrics ?? {}) as CategoryMetrics,
    })
  );

  // Worst first: a CRIT must never be below the fold.
  const rank: Record<CategoryStatus, number> = { CRIT: 0, WARN: 1, INFO: 2, OK: 3 };
  categories.sort((a, b) => rank[a.status] - rank[b.status]);

  // The checker rounds: it reported 100 while still carrying a WARN worth 0.3,
  // so the headline number and the status colour contradicted each other on
  // screen. Recompute from the penalties so 100 means nothing was deducted.
  const deducted = categories.reduce((sum, c) => sum + (c.penalty || 0), 0);
  const exactScore = Math.round((100 - deducted) * 10) / 10;

  const cpuStr = String(parsed.system?.CPU ?? "");
  const coreMatch = cpuStr.match(/\((\d+)C\s*\/\s*\d+T\)/i);

  return {
    timestamp: String(parsed.timestamp ?? ""),
    score: Number(parsed.score ?? 0),
    exactScore,
    grade: String(parsed.grade ?? "?"),
    headline: String(parsed.headline ?? ""),
    days: Number(parsed.days ?? 0),
    computer: String(parsed.system?.Computer ?? ""),
    cpu: cpuStr,
    cores: coreMatch ? Number(coreMatch[1]) : 0,
    os: String(parsed.system?.OS ?? ""),
    bios: String(parsed.system?.BIOS ?? ""),
    categories,
  };
};

const metricOf = (r: HealthReport, name: string, key: string): number => {
  const c = r.categories.find((x) => x.name === name);
  const v = c?.metrics ? (c.metrics as Record<string, unknown>)[key] : undefined;
  return typeof v === "number" ? v : 0;
};

const RANK: Record<CategoryStatus, number> = { OK: 0, INFO: 1, WARN: 2, CRIT: 3 };

/**
 * Diff two scans.
 *
 * Counts come from the 30-day metrics rather than the 120-day totals on
 * purpose: the 120-day window slides, so an old error ageing out of it reads
 * as an improvement that never happened. Between two scans days apart, the
 * 30-day figure is the one that only moves when something actually occurred.
 */
const computeDelta = (now: HealthReport, prev: HealthReport): HealthDelta => {
  const changes: StatusChange[] = [];
  for (const c of now.categories) {
    const before = prev.categories.find((x) => x.name === c.name);
    if (!before || before.status === c.status) continue;
    changes.push({
      name: c.name,
      from: before.status,
      to: c.status,
      worse: RANK[c.status] > RANK[before.status],
    });
  }
  changes.sort((a, b) => RANK[b.to] - RANK[a.to]);

  const whea = "Hardware Errors (WHEA)";
  const crash = "Stability / Crashes";
  return {
    since: prev.timestamp,
    scoreDelta: Math.round((now.exactScore - prev.exactScore) * 10) / 10,
    newWhea30d: Math.max(
      0,
      metricOf(now, whea, "corrected_30d") - metricOf(prev, whea, "corrected_30d")
    ),
    newCrashes30d: Math.max(
      0,
      metricOf(now, crash, "kp41_30d") +
        metricOf(now, crash, "bsod_30d") -
        metricOf(prev, crash, "kp41_30d") -
        metricOf(prev, crash, "bsod_30d")
    ),
    changes,
  };
};

const readReport = async (): Promise<HealthPayload> => {
  const now = new Date().toISOString();
  try {
    const paths = await newestReportPaths(cfg.dir);
    if (paths.length === 0) {
      return { report: null, delta: null, updated: now, error: "No health reports found" };
    }

    const report = await parseReport(paths[0]);

    // A missing or unreadable previous report is not an error - it just means
    // there is nothing to compare against yet, so the screen omits the line.
    let delta: HealthDelta | null = null;
    if (paths[1]) {
      try {
        delta = computeDelta(report, await parseReport(paths[1]));
      } catch {
        delta = null;
      }
    }

    return { report, delta, updated: now };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return { report: null, delta: null, updated: now, error: `Not found: ${cfg.dir}` };
    }
    return {
      report: null,
      delta: null,
      updated: now,
      error: `Cannot read report (${code ?? (err as Error)?.message ?? "unknown"})`,
    };
  }
};

const pushHealth = async (clientId?: string, force = false) => {
  if (reading) return;
  reading = true;
  try {
    const payload = await readReport();
    const serialized = JSON.stringify(payload.report) + (payload.error ?? "");
    if (!clientId && !force && serialized === lastSerialized) return;
    if (!clientId) lastSerialized = serialized;

    console.log(
      `[pc-health] sending ${payload.report ? `score ${payload.report.exactScore} (${payload.report.categories.length} categories)` : "no report"}` +
        `${clientId ? ` to ${clientId}` : " (broadcast)"}` +
        `${payload.error ? ` error=${payload.error}` : ""}`
    );

    DeskThing.send({
      clientId,
      type: SERVER_TYPE.HEALTH,
      request: "update",
      payload,
    });
  } finally {
    reading = false;
  }
};

const armPolling = (ms: number) => {
  if (cancelPoll && armedIntervalMs === ms) return;
  if (typeof cancelPoll === "function") {
    try {
      cancelPoll();
    } catch {
      /* ignore */
    }
  }
  cancelPoll = null;
  armedIntervalMs = ms;
  const handle = DeskThing.setInterval(() => {
    void pushHealth();
  }, ms);
  cancelPoll = typeof handle === "function" ? handle : null;
  console.log(`[pc-health] polling every ${ms}ms`);
};

const applySettings = (settings: AppSettings | undefined) => {
  if (!settings) return;
  const d = settings[SETTING_IDS.DIR];
  if (d && d.type === SETTING_TYPES.STRING && typeof d.value === "string" && d.value.trim()) {
    cfg.dir = d.value;
  }
  const i = settings[SETTING_IDS.INTERVAL];
  if (i && i.type === SETTING_TYPES.NUMBER && typeof i.value === "number") {
    cfg.interval = i.value;
  }
};

const start = async () => {
  console.log(`[pc-health] starting; history dir = ${cfg.dir}`);

  const settings: AppSettings = {
    [SETTING_IDS.DIR]: {
      id: SETTING_IDS.DIR,
      label: "Report Folder",
      type: SETTING_TYPES.STRING,
      value: DEFAULTS.dir,
      description: "Folder containing PC Health Checker's health-*.json reports.",
    },
    [SETTING_IDS.INTERVAL]: {
      id: SETTING_IDS.INTERVAL,
      label: "Refresh Interval (seconds)",
      type: SETTING_TYPES.NUMBER,
      value: DEFAULTS.interval,
      min: 10,
      max: 3600,
      description: "Reports are generated on a schedule, so this can be slow.",
    },
  };

  await DeskThing.initSettings(settings);
  try {
    applySettings(await DeskThing.getSettings());
  } catch {
    /* keep defaults */
  }

  DeskThing.on(CLIENT_TYPE.HEALTH, async (data) => {
    if (data.request === "get") await pushHealth(data.clientId);
  });

  // A client that opens later gets no broadcast, because the poll only sends on
  // change. Push on connect so the screen always populates.
  DeskThing.on(DESKTHING_EVENTS.CLIENT_STATUS, (data) => {
    if (data?.request === "opened" || data?.request === "connected") {
      void pushHealth(undefined, true);
    }
  });

  DeskThing.on(DESKTHING_EVENTS.SETTINGS, (event) => {
    const before = cfg.interval;
    applySettings(event?.payload as AppSettings | undefined);
    lastSerialized = "";
    if (cfg.interval !== before) armPolling(Math.max(5000, cfg.interval * 1000));
    void pushHealth(undefined, true);
  });

  armPolling(Math.max(5000, cfg.interval * 1000));
  await pushHealth(undefined, true);
  console.log("[pc-health] ready");
};

const stop = async () => {
  if (typeof cancelPoll === "function") {
    try {
      cancelPoll();
    } catch {
      /* ignore */
    }
  }
  cancelPoll = null;
  armedIntervalMs = 0;
  lastSerialized = "";
  reading = false;
};

DeskThing.on(DESKTHING_EVENTS.START, start);
DeskThing.on(DESKTHING_EVENTS.STOP, stop);
