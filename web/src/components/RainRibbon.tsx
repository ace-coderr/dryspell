import { useMemo } from "react";
import type { PerilName } from "../lib/data";

export interface RibbonSeries {
  name: string;
  color: string;
  mm: number[]; // daily rainfall, already scaled by the published calibration factor
}

/**
 * The Dryspell signature visual: a season of rain drawn as a ribbon that animates in from the left
 * and runs into the trigger line.
 *  - drought: running total of rainfall. The ribbon ends above the line (no payout) or beneath it (pays).
 *  - flood:   rolling 3-day rainfall. Where the ribbon rises through the line, the cover pays.
 */
export function RainRibbon({ series, threshold, kind, height = 300, replayKey = "" }: { series: RibbonSeries[]; threshold: number; kind: PerilName; height?: number; replayKey?: string }) {
  const W = 800;
  const H = height;
  const pad = { l: 46, r: 16, t: 18, b: 30 };

  const lines = useMemo(() => {
    return series.map((s) => {
      let v: number[];
      if (kind === "drought") {
        let c = 0;
        v = s.mm.map((x) => (c += x));
      } else {
        v = s.mm.map((_, i) => (i < 2 ? 0 : s.mm[i] + s.mm[i - 1] + s.mm[i - 2]));
      }
      return { ...s, v };
    });
  }, [series, kind]);

  const n = lines[0]?.v.length ?? 0;
  const maxV = Math.max(threshold * 1.15, ...lines.flatMap((l) => l.v), 1);
  const x = (i: number) => pad.l + (i / Math.max(1, n - 1)) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / maxV) * (H - pad.t - pad.b);
  const ty = y(threshold);

  if (!n) return null;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * maxV);

  return (
    <div className="ribbon-wrap" key={replayKey}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Rainfall ribbon against the ${threshold} millimetre trigger`}>
        <defs>
          {lines.map((l, i) => (
            <linearGradient id={`rg${i}`} key={i} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={l.color} stopOpacity="0.38" />
              <stop offset="1" stopColor={l.color} stopOpacity="0.02" />
            </linearGradient>
          ))}
        </defs>
        {ticks.map((t, i) => (
          <g key={i}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--rule)" strokeWidth="1" strokeDasharray={i ? "2 4" : "0"} />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontFamily="var(--mono)" fontSize="11" fill="var(--ink-3)">
              {Math.round(t)}
            </text>
          </g>
        ))}
        <text x={pad.l} y={H - 8} fontFamily="var(--mono)" fontSize="11" fill="var(--ink-3)">season start</text>
        <text x={W - pad.r} y={H - 8} textAnchor="end" fontFamily="var(--mono)" fontSize="11" fill="var(--ink-3)">season end</text>
        <text x={pad.l} y={11} fontFamily="var(--mono)" fontSize="11" fill="var(--ink-3)">{kind === "drought" ? "season rainfall to date (mm)" : "rolling 3-day rainfall (mm)"}</text>

        {lines.map((l, i) => {
          const d = l.v.map((v, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
          const area = `${d} L${x(n - 1).toFixed(1)},${(H - pad.b).toFixed(1)} L${pad.l},${H - pad.b} Z`;
          return (
            <g key={l.name}>
              <path d={area} fill={`url(#rg${i})`} style={{ opacity: 0, animation: `rise 1s ${1.6 + i * 0.1}s ease forwards` }} />
              <path d={d} fill="none" stroke={l.color} strokeWidth={i === 0 ? 3.2 : 2} strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray={1} strokeDashoffset={1} style={{ animation: `draw 1.8s ${i * 0.15}s cubic-bezier(.3,.7,.2,1) forwards` }} />
            </g>
          );
        })}

        <g>
          <line x1={pad.l} x2={W - pad.r} y1={ty} y2={ty} stroke="var(--drought)" strokeWidth="2.4" strokeDasharray="7 5" />
          <rect x={W - pad.r - 148} y={ty - 25} width="148" height="20" fill="var(--paper)" stroke="var(--drought)" />
          <text x={W - pad.r - 74} y={ty - 11} textAnchor="middle" fontFamily="var(--mono)" fontSize="11" fontWeight="600" fill="var(--drought)">
            TRIGGER {threshold} mm
          </text>
        </g>
      </svg>
      <div className="legend">
        {lines.map((l) => (
          <span key={l.name} style={{ ["--c" as any]: l.color }}>{l.name}</span>
        ))}
      </div>
    </div>
  );
}
