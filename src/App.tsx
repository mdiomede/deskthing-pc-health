import React, { useEffect, useMemo, useRef, useState } from "react";
import { createDeskThing } from "@deskthing/client";
import { EventMode } from "@deskthing/types";
import {
  CLIENT_TYPE,
  SERVER_TYPE,
  CategoryStatus,
  CoreTemp,
  EventSeries,
  HealthCategory,
  HealthDelta,
  HealthPayload,
  HealthReport,
  ToClientData,
  ToServerData,
} from "../shared/transit";

const DeskThing = createDeskThing<ToClientData, ToServerData>();

/* ---------------------------------------------------------------------------
 * This screen is a cockpit, not an alert board. The sibling Claude Status app
 * answers "do I need to get up right now" and is allowed to shout. This one
 * answers "how has this machine been", which is a question about time - so the
 * signature element is a 120-day event recorder built from the checker's byDay
 * series, and nothing on screen is permitted to shout.
 * ------------------------------------------------------------------------- */

const TONE: Record<CategoryStatus, string> = {
  CRIT: "text-crit",
  WARN: "text-warn",
  INFO: "text-info",
  OK: "text-ok",
};
const FILL: Record<CategoryStatus, string> = {
  CRIT: "bg-crit",
  WARN: "bg-warn",
  INFO: "bg-info",
  OK: "bg-ok",
};

/** Score bands. 100 is only reachable when nothing at all was deducted. */
const scoreTone = (n: number): CategoryStatus =>
  n >= 99.95 ? "OK" : n >= 75 ? "WARN" : "CRIT";

const RING_HEX: Record<CategoryStatus, string> = {
  OK: "oklch(0.80 0.15 155)",
  INFO: "oklch(0.76 0.12 240)",
  WARN: "oklch(0.83 0.15 82)",
  CRIT: "oklch(0.68 0.19 25)",
};

const ago = (isoStr: string): string => {
  const t = Date.parse(isoStr);
  if (Number.isNaN(t)) return "";
  const h = (Date.now() - t) / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m ago`;
  if (h < 48) return `${Math.round(h)}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

/**
 * Date formatting WITHOUT Intl.
 *
 * The Car Thing's Chromium is built with minimal ICU, so
 * `toLocaleString(undefined, { month: "short" })` silently ignores the options
 * and returns the whole `Sat May 02 2026 12:05:01 GMT-0400 (...)` string. Four
 * of those absolutely positioned on the month axis rendered as one unreadable
 * pile. Anything user-visible here has to be formatted by hand.
 */
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const shortMonth = (d: Date): string => MONTHS[d.getMonth()] ?? "";

/** e.g. "Thu 4:36 PM" */
const shortWhen = (d: Date): string => {
  const h24 = d.getHours();
  const h = h24 % 12 === 0 ? 12 : h24 % 12;
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${WEEKDAYS[d.getDay()]} ${h}:${m} ${h24 < 12 ? "AM" : "PM"}`;
};

/** Thousands separators without Number.prototype.toLocaleString. */
const grouped = (n: number): string =>
  String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const dayKey = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/**
 * Expand a sparse {date: count} map into one bucket per day across the window,
 * ending on the report's own timestamp rather than "now" - a stale report must
 * not silently slide its axis forward and imply days it never measured.
 */
const toDays = (series: EventSeries | undefined, end: Date, days: number) => {
  const out: { date: Date; n: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end);
    d.setDate(d.getDate() - i);
    out.push({ date: d, n: series?.[dayKey(d)] ?? 0 });
  }
  return out;
};

const Ring: React.FC<{ value: number; tone: CategoryStatus; grade: string }> = ({
  value,
  tone,
  grade,
}) => {
  const R = 46;
  const C = 2 * Math.PI * R;
  const pct = Math.max(0, Math.min(100, value)) / 100;
  return (
    <div className="relative h-[112px] w-[112px] shrink-0">
      <svg viewBox="0 0 112 112" className="h-full w-full -rotate-90">
        <circle cx="56" cy="56" r={R} fill="none" strokeWidth="7" stroke="oklch(0.30 0.010 75)" />
        <circle
          cx="56"
          cy="56"
          r={R}
          fill="none"
          strokeWidth="7"
          strokeLinecap="round"
          stroke={RING_HEX[tone]}
          strokeDasharray={`${C * pct} ${C}`}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-display text-ring font-semibold tabular-nums text-tx">
          {Number.isInteger(value) ? value : value.toFixed(1)}
        </span>
        <span className="mt-1 text-micro font-semibold uppercase text-faint">grade {grade}</span>
      </div>
    </div>
  );
};

/** One recorder track: one column per day, height by event count. */
const Track: React.FC<{
  label: string;
  sub: string;
  tone: CategoryStatus;
  buckets: { date: Date; n: number }[];
  onOpen: () => void;
}> = ({ label, sub, tone, buckets, onOpen }) => {
  const max = Math.max(1, ...buckets.map((b) => b.n));
  return (
    <button onClick={onOpen} className="flex w-full items-center gap-4 py-1.5 text-left">
      <div className="w-[152px] shrink-0">
        <div className="flex items-center gap-2">
          <span className={`h-[7px] w-[7px] shrink-0 rounded-full ${FILL[tone]}`} />
          <span className="text-[13px] font-semibold text-tx">{label}</span>
        </div>
        {/* truncate, not wrap. "12 corrected · 1 fatal" is ~121px against
            117px of usable column, so without this it takes a second line,
            grows both track rows, and shoves the month axis into them. */}
        <div className="mt-1 truncate whitespace-nowrap pl-[15px] text-[11px] text-faint">
          {sub}
        </div>
      </div>
      <div className="flex h-[46px] min-w-0 flex-1 items-end gap-px">
        {buckets.map((b, i) => (
          <div
            key={i}
            className={`min-w-0 flex-1 rounded-[1px] ${b.n ? FILL[tone] : "bg-line"}`}
            style={{
              height: b.n ? `${Math.max(14, (b.n / max) * 100)}%` : "2px",
              opacity: b.n ? 1 : 0.55,
            }}
          />
        ))}
      </div>
    </button>
  );
};

/**
 * Ten cores as a grid, hottest lit.
 *
 * This is the one panel element that is diagnostic rather than informational:
 * on this machine cores 4 and 5 run consistently hotter than the other eight,
 * and those are the same two cores the corrected WHEA errors land on. A row of
 * numbers buries that; a grid makes it the first thing you see.
 *
 * "Hot" is relative to this reading, not an absolute threshold - the point is
 * which cores are outliers today, not whether the chip is overheating (it is
 * not; 55C is unremarkable).
 */
const CoreGrid: React.FC<{
  cores: CoreTemp[];
  /** Corrected WHEA errors per physical core, over the report's window. */
  errors?: Record<string, number>;
  /** Big enough to read a temperature in each cell, for the detail overlay. */
  large?: boolean;
  onOpen?: () => void;
}> = ({ cores, errors, large, onOpen }) => {
  const max = Math.max(...cores.map((c) => c.c));
  // Large cells FILL their grid column and stay square, rather than being
  // pinned to a fixed width. Pinning them to 54px inside a full-width
  // grid-cols-5 put a small square at the left edge of each ~146px column,
  // which reads as five separated pairs with dead space between them instead
  // of one dense block. Small cells keep a fixed size because the hero has no
  // width to give them.
  const cell = large
    ? "w-full aspect-square text-[15px]"
    : "h-[23px] w-[23px] text-[10px]";
  const Tag = (onOpen ? "button" : "div") as React.ElementType;
  return (
    <Tag onClick={onOpen} className="shrink-0 text-left">
      <div className="mb-1.5 text-micro font-semibold uppercase text-faint">
        {large ? "Cores · °C" : "Cores"}
      </div>
      {/* 5 across, 2 down, square, numbered - ported from the desktop report's
          `.cores { grid-template-columns: repeat(5,1fr) }` rule.
          Two earlier attempts laid all ten out in ONE row and just made the
          cells bigger. Ten cells in a line is a segmented progress bar no
          matter how tall they are; the thing that makes this read as a grid is
          that it is two-dimensional and the cells are square with a number in
          them. Shape, not size. */}
      <div
        className={`grid grid-cols-5 ${
          large ? "w-full max-w-[600px] gap-2.5" : "gap-1"
        }`}
      >
        {cores.map((c) => {
          const hot = c.c >= max - 1;
          const errs = errors?.[String(c.n)] ?? 0;
          return (
            <div
              key={c.n}
              title={`core ${c.n}: ${c.c}C${errs ? `, ${errs} corrected errors` : ""}`}
              className={`relative flex ${cell} flex-col items-center justify-center rounded-[4px] font-display font-semibold leading-none ${
                hot ? "bg-warn text-bg" : "bg-raise text-faint"
              } ${errs ? "ring-2 ring-crit" : ""}`}
            >
              {/* Fill = temperature. Ring = corrected errors. Two independent
                  signals, deliberately encoded differently so a core that is
                  merely warm is never mistaken for one that is faulting. */}
              {errs > 0 && large && (
                <span className="absolute -right-1.5 -top-1.5 rounded-full bg-crit px-1.5 py-0.5 text-[12px] font-bold text-bone">
                  {errs}
                </span>
              )}
              {/* Small: just the core number, enough to see WHICH is lit.
                  Large: the number and its temperature, since at 54px there is
                  room to actually read it. */}
              <span className={large ? "text-[13px] opacity-60" : ""}>{c.n}</span>
              {large && <span className="mt-1 text-[30px] leading-none">{c.c}</span>}
            </div>
          );
        })}
      </div>
    </Tag>
  );
};

const Vital: React.FC<{
  label: string;
  value: React.ReactNode;
  sub: string;
  bar?: number;
  /** Optional visual slotted between the value and the sub line. */
  grid?: React.ReactNode;
  /** Claim extra width - the core grid needs it to be readable. */
  wide?: boolean;
  last?: boolean;
}> = ({ label, value, sub, bar, grid, wide, last }) => (
  <div
    className={`flex flex-col gap-1 px-4 py-3 ${wide ? "flex-[1.6]" : "flex-1"} ${
      last ? "" : "border-r border-line"
    }`}
  >
    <div className="text-micro font-semibold uppercase text-faint">{label}</div>
    <div className="font-display text-val font-semibold tabular-nums text-tx">{value}</div>
    {bar !== undefined && (
      <div className="mt-0.5 h-[5px] overflow-hidden rounded-full bg-line">
        <div className="h-full rounded-full bg-ok" style={{ width: `${Math.min(100, bar)}%` }} />
      </div>
    )}
    {grid}
    <div className="truncate text-[11px] text-mut">{sub}</div>
  </div>
);

/**
 * What changed since the previous scan.
 *
 * A snapshot is a bad fit for a screen you glance at: 93 means nothing unless
 * you remember it was 100 yesterday. This line is the one thing on the panel
 * that answers a question you actually have, so it sits directly under the
 * score and states the quiet case as plainly as the noisy one.
 */
const Since: React.FC<{ delta: HealthDelta }> = ({ delta }) => {
  const when = (() => {
    const t = Date.parse(delta.since);
    if (Number.isNaN(t)) return "the last scan";
    return shortWhen(new Date(t));
  })();

  const bits: string[] = [];
  if (delta.scoreDelta !== 0) {
    bits.push(`${delta.scoreDelta > 0 ? "+" : ""}${delta.scoreDelta} score`);
  }
  if (delta.newWhea30d > 0) bits.push(`${delta.newWhea30d} new WHEA`);
  if (delta.newCrashes30d > 0) bits.push(`${delta.newCrashes30d} new crash`);
  for (const c of delta.changes.slice(0, 2)) {
    bits.push(`${c.name.split(" ")[0]} ${c.from}→${c.to}`);
  }

  const bad = delta.scoreDelta < 0 || delta.changes.some((c) => c.worse);
  const quiet = bits.length === 0;

  return (
    <div
      className={`mt-2.5 flex shrink-0 items-center gap-2.5 rounded-lg border px-3.5 py-2 ${
        quiet
          ? "border-ok/25 bg-ok/[0.07]"
          : bad
          ? "border-warn/40 bg-warn/[0.09]"
          : "border-ok/25 bg-ok/[0.07]"
      }`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${bad && !quiet ? "bg-warn" : "bg-ok"}`}
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-read">
        {quiet ? (
          <>Nothing changed since {when}</>
        ) : (
          <>
            Since {when}: <span className="font-semibold text-tx">{bits.join(" · ")}</span>
          </>
        )}
      </span>
    </div>
  );
};

const App: React.FC = () => {
  const [health, setHealth] = useState<HealthPayload | null>(null);
  const [openCat, setOpenCat] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (attempt = 0) => {
      if (cancelled) return;
      try {
        const res = await DeskThing.fetch(
          { type: CLIENT_TYPE.HEALTH, request: "get", payload: undefined },
          { type: SERVER_TYPE.HEALTH, request: "update" }
        );
        if (!cancelled && res?.payload) {
          setHealth(res.payload);
          return;
        }
      } catch {
        /* retry below */
      }
      if (!cancelled && attempt < 6) setTimeout(() => load(attempt + 1), 400 + attempt * 600);
    };
    load();

    const off = DeskThing.on(SERVER_TYPE.HEALTH, (data) => {
      if (data.payload) setHealth(data.payload);
    });

    // The key string must be "wheel"; the JSDoc's "Scroll" is not what the
    // client actually checks.
    DeskThing.overrideKeys(["wheel"]);

    /* -----------------------------------------------------------------------
     * Make the four physical preset buttons work while this app is open.
     *
     * DeskThing's client shell listens for the button keydowns on ITS document.
     * The moment an app's iframe takes focus the events land in the iframe
     * instead, and key events do not cross document boundaries - so the shell
     * never sees them and the buttons go dead until you swipe back out. The
     * client library attaches no key listener of its own (it only listens for
     * postMessage), so nothing forwards them on your behalf.
     *
     * triggerKey is the supported way back: catch the key here and hand it to
     * the shell, which runs whatever the mapping has bound to it. That keeps
     * the binding as the single source of truth - this does not hardcode which
     * app each button opens, so remapping in the UI still works.
     *
     * PressShort (10) is deliberate: mode 11 (PressLong) never fires on this
     * client, so mode 10 is the only one the bindings actually use.
     * --------------------------------------------------------------------- */
    const onPresetKey = (e: KeyboardEvent) => {
      if (!/^Digit[1-4]$/.test(e.code)) return;
      e.preventDefault();
      // KeyReference is { id, mode, source } - the library's own JSDoc says
      // `key`, which does not compile. Trust the type, not the comment.
      void DeskThing.triggerKey({
        id: e.code,
        mode: EventMode.PressShort,
        source: "server",
      });
    };
    window.addEventListener("keydown", onPresetKey);
    document.addEventListener("keydown", onPresetKey);

    const onWheel = (e: WheelEvent) => {
      const el = scroller.current;
      if (!el) return;
      const raw = e.deltaY !== 0 ? e.deltaY : e.deltaX;
      if (raw !== 0) el.scrollBy({ top: Math.sign(raw) * 90 });
    };
    window.addEventListener("wheel", onWheel, { passive: true });
    document.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      cancelled = true;
      off();
      window.removeEventListener("keydown", onPresetKey);
      document.removeEventListener("keydown", onPresetKey);
      window.removeEventListener("wheel", onWheel);
      document.removeEventListener("wheel", onWheel);
      DeskThing.restoreKeys(["wheel"]);
    };
  }, []);

  const report: HealthReport | null = health?.report ?? null;
  const cats: HealthCategory[] = report?.categories ?? [];
  const by = (n: string) => cats.find((c) => c.name === n);

  const end = useMemo(
    () => (report?.timestamp ? new Date(report.timestamp) : new Date()),
    [report?.timestamp]
  );
  const whea = by("Hardware Errors (WHEA)");
  const crash = by("Stability / Crashes");
  const days = report?.days || 120;
  const wheaDays = useMemo(() => toDays(whea?.metrics.byDay, end, days), [whea, end, days]);
  const crashDays = useMemo(() => toDays(crash?.metrics.byDay, end, days), [crash, end, days]);

  const monthTicks = useMemo(() => {
    const seen = new Set<string>();
    const out: { i: number; label: string }[] = [];
    wheaDays.forEach((b, i) => {
      const k = `${b.date.getFullYear()}-${b.date.getMonth()}`;
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ i, label: shortMonth(b.date) });
    });
    return out;
  }, [wheaDays]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [openCat]);

  if (health?.error) {
    return (
      <div className="flex h-screen w-screen items-center bg-bg px-10 font-body">
        <p className="text-verdict font-semibold text-crit">{health.error}</p>
      </div>
    );
  }
  if (!report) {
    return (
      <div className="flex h-screen w-screen flex-col justify-center bg-bg px-10 font-body">
        <p className="font-display text-verdict font-semibold text-mut">Waiting for a scan</p>
        <p className="mt-2 text-[13px] text-faint">
          PC Health Check runs every 6 hours and writes the report this screen reads.
        </p>
      </div>
    );
  }

  const attention = cats.filter((c) => c.status === "WARN" || c.status === "CRIT");
  const tone = scoreTone(report.exactScore);
  const mem = by("Memory")?.metrics;
  const rel = by("Reliability Index")?.metrics;
  const up = by("Uptime / Boot")?.metrics;
  const therm = by("Thermals")?.metrics;
  const drives = by("Storage")?.metrics.drives ?? [];
  const freeGB = drives.reduce((s, d) => s + d.vols.reduce((v, x) => v + (x.freeGB || 0), 0), 0);
  const open = openCat ? by(openCat) : null;

  return (
    // pb-6, not pb-3: the bottom edge belongs to the system's now-playing bar,
    // which is drawn over this app even with no audio app installed.
    <div className="relative flex h-screen w-screen flex-col bg-bg px-5 pb-6 pt-4 font-body text-tx">
      {/* Hero. The ring carries the state so the number never has to: a 93 in
          amber text reads as an accusation, a neutral 93 inside an amber arc
          reads as a measurement. */}
      <div className="flex shrink-0 items-center gap-5">
        <Ring value={report.exactScore} tone={tone} grade={report.grade} />
        <div className="min-w-0 flex-1">
          <div className="font-display text-verdict font-semibold">{report.headline}</div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {attention.length === 0 ? (
              <span className="text-[12.5px] text-mut">Nothing needs attention</span>
            ) : (
              attention.map((c) => (
                <button
                  key={c.name}
                  onClick={() => setOpenCat(c.name)}
                  className="rounded-md border border-line bg-surface px-2 py-1 text-[11.5px] font-semibold"
                >
                  <span className={TONE[c.status]}>{c.name}</span>
                  <span className="ml-1.5 tabular-nums text-faint">-{c.penalty}</span>
                </button>
              ))
            )}
          </div>
        </div>
        {therm?.cores?.length ? (
          <CoreGrid
            cores={therm.cores}
            errors={whea?.metrics.byCore}
            onOpen={() => setOpenCat("Thermals")}
          />
        ) : null}

        {/* ml-7 on top of the row's gap-5: the machine name is right-aligned and
            long ("WATCHUKNOWABOUT"), so 20px of gap left it touching the grid.
            Separation lives here rather than on the grid so the grid stays
            centred in the slack the flex-1 verdict block leaves. */}
        <div className="ml-7 shrink-0 text-right">
          <div className="text-[12px] font-semibold text-mut">{report.computer}</div>
          <div className="mt-1 text-[11px] tabular-nums text-faint">{ago(report.timestamp)}</div>
          <div className="text-[11px] text-faint">{days}d window</div>
        </div>
      </div>

      {health?.delta && <Since delta={health.delta} />}

      {/* Vitals. Every cell is a number the checker actually measured. */}
      <div className="mt-2.5 flex shrink-0 overflow-hidden rounded-xl border border-line bg-surface">
        <Vital
          label="WHEA 30d"
          value={whea?.metrics.corrected_30d ?? 0}
          sub={`${whea?.metrics.corrected ?? 0} in ${days}d`}
        />
        <Vital
          label="Memory"
          value={
            <>
              {Math.round(mem?.usedPct ?? 0)}
              <span className="text-[15px] text-faint">%</span>
            </>
          }
          bar={mem?.usedPct ?? 0}
          sub={`of ${mem?.totalGB ?? 0} GB`}
        />
        <Vital
          label="Free"
          value={
            <>
              {grouped(freeGB)}
              <span className="text-[15px] text-faint"> GB</span>
            </>
          }
          sub={`${drives.length} drives healthy`}
        />
        <Vital
          label="Reliability"
          value={(rel?.latest ?? 0).toFixed(2)}
          sub={`14d avg ${(rel?.avg14 ?? 0).toFixed(1)}`}
        />
        {/* CPU replaces Uptime here: uptime is a number you already know, and
            the core grid is the only thing on this screen that can show WHICH
            part of the machine is the outlier. Falls back to uptime when
            HWiNFO is not publishing, rather than rendering an empty cell. */}
        {therm?.cores?.length ? (
          <Vital
            label="CPU"
            value={
              <>
                {Math.round(therm.cpuMaxC ?? 0)}
                <span className="text-[15px] text-faint">°C</span>
              </>
            }
            sub={therm.gpuC ? `GPU ${Math.round(therm.gpuC)}°C` : `${therm.cores.length} cores`}
            last
          />
        ) : (
          <Vital
            label="Uptime"
            value={
              <>
                {(up?.uptimeDays ?? 0).toFixed(1)}
                <span className="text-[15px] text-faint">d</span>
              </>
            }
            sub={`${up?.slowBoots ?? 0} slow boots`}
            last
          />
        )}
      </div>

      {/* The recorder: the element the desktop report has and the old screen
          threw away. Real dated events, one column per day. */}
      <div className="mt-3 flex min-h-0 flex-1 flex-col rounded-xl border border-line bg-surface px-5 pb-2 pt-3">
        <div className="mb-1 flex shrink-0 items-baseline justify-between">
          <span className="text-tag font-semibold uppercase text-mut">Recorder</span>
          <span className="text-[11px] text-faint">tap a track for detail</span>
        </div>
        <Track
          label="WHEA"
          sub={`${whea?.metrics.corrected ?? 0} corrected · ${whea?.metrics.uncorrected ?? 0} fatal`}
          tone={whea?.status ?? "OK"}
          buckets={wheaDays}
          onOpen={() => setOpenCat(whea?.name ?? null)}
        />
        <Track
          label="Crashes"
          sub={`${crash?.metrics.kp41 ?? 0} shutdowns · ${crash?.metrics.bsod ?? 0} BSOD`}
          tone={crash?.status ?? "OK"}
          buckets={crashDays}
          onOpen={() => setOpenCat(crash?.name ?? null)}
        />
        {/* Offset must track the label column width + the gap-4 (16px), or the
            axis drifts out of register with the bars above it. */}
        <div className="relative ml-[168px] mt-1 h-4 shrink-0">
          {monthTicks.map((t) => (
            <span
              key={t.i}
              className="absolute whitespace-nowrap text-[10.5px] leading-none text-faint"
              style={{ left: `${(t.i / days) * 100}%` }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>

      {/* Detail overlay. The old screen spent a permanent 240px rail on
          navigation; here detail is summoned and dismissed, so the cockpit
          keeps the full width. */}
      {open && (
        // Fully opaque. This started at bg-bg/95 as a hint that the cockpit was
        // still underneath, and the 5% bleed-through made the text unreadable on
        // the panel. Legibility beats the layering cue.
        <div
          className="absolute inset-0 z-10 flex flex-col bg-bg px-7 pb-5 pt-5"
          onClick={() => setOpenCat(null)}
        >
          <div className="flex shrink-0 items-baseline justify-between border-b border-line pb-3">
            <span className="font-display text-[20px] font-semibold">{open.name}</span>
            <span className={`text-tag font-bold uppercase ${TONE[open.status]}`}>
              {open.status}
              {open.penalty > 0 ? ` · -${open.penalty}` : ""}
            </span>
          </div>
          <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pt-3">
            {open.name === "Thermals" && open.metrics.cores?.length ? (
              <div className="mb-4">
                <CoreGrid cores={open.metrics.cores} errors={whea?.metrics.byCore} large />
              </div>
            ) : null}
            <ul className="flex flex-col gap-2.5">
              {open.details.map((d, i) => (
                <li key={i} className="relative pl-4 text-[16px] leading-relaxed text-read">
                  <span className="absolute left-0 top-[9px] h-[3px] w-[3px] rounded-full bg-faint" />
                  {d}
                </li>
              ))}
            </ul>
          </div>
          <div className="shrink-0 pt-2 text-[11px] text-faint">tap anywhere to close</div>
        </div>
      )}
    </div>
  );
};

export default App;
