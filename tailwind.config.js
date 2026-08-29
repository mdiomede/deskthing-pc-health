/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        // Ported verbatim from the desktop report's :root block so the Car
        // Thing and the HTML report are recognisably the same instrument.
        // The sibling alert app uses a warmer hue-70 neutral and only one
        // saturated colour; this one is hue-75/85 and carries a full status
        // scale, because a dashboard grades things and an alert only shouts.
        bg: "oklch(0.155 0.008 75)",
        surface: "oklch(0.205 0.009 75)",
        raise: "oklch(0.255 0.010 75)",
        line: "oklch(0.30 0.010 75)",
        tx: "oklch(0.95 0.008 85)",
        mut: "oklch(0.72 0.010 85)",
        faint: "oklch(0.56 0.010 85)",
        // The report's own reading colour for detail bullets (.dlist li). Sits
        // between mut and tx: bright enough to read a paragraph at arm's length
        // without going full white and shouting.
        read: "oklch(0.82 0.008 85)",
        ok: "oklch(0.80 0.15 155)",
        info: "oklch(0.76 0.12 240)",
        warn: "oklch(0.83 0.15 82)",
        crit: "oklch(0.68 0.19 25)",
      },
      fontFamily: {
        // The report pairs Space Grotesk for numerals and headings with Inter
        // for prose. Neither is bundled, so both fall back to the system stack;
        // the design holds either way because hierarchy comes from size and
        // weight, not from the face.
        display: ["'Space Grotesk'", "Inter", "system-ui", "sans-serif"],
        body: ["Inter", "system-ui", "-apple-system", "sans-serif"],
      },
      fontSize: {
        micro: ["0.625rem", { lineHeight: "1", letterSpacing: "0.12em" }],
        tag: ["0.6875rem", { lineHeight: "1", letterSpacing: "0.11em" }],
        val: ["1.5rem", { lineHeight: "1", letterSpacing: "-0.01em" }],
        verdict: ["1.75rem", { lineHeight: "1", letterSpacing: "-0.02em" }],
        ring: ["2.75rem", { lineHeight: "1", letterSpacing: "-0.02em" }],
      },
    },
  },
  plugins: [],
};
