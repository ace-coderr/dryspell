// Port of the engine's pricing math (contracts/stylus/src/pricing.rs). The chain's quote() is the
// source of truth; this exists to explain a premium component by component and to backtest offline.
import type { PerilName, TableRow } from "./data";

export interface EngineParams {
  marginKBps: bigint;
  floorPpm: bigint;
  loadingBps: bigint;
  maxRatePpm: bigint;
  maxUtilBps: bigint;
}

const ceilDiv = (a: bigint, b: bigint) => a / b + (a % b === 0n ? 0n : 1n);

export function interpolate(peril: PerilName, table: TableRow[], level: number): { p: bigint; se: bigint } | null {
  const first = table[0].level_mm;
  const last = table[table.length - 1].level_mm;
  const inside = peril === "drought" ? level >= first && level <= last : level <= first && level >= last;
  if (!inside) return null;
  for (let i = 0; i + 1 < table.length; i++) {
    const a = table[i];
    const b = table[i + 1];
    const within = peril === "drought" ? level >= a.level_mm && level <= b.level_mm : level <= a.level_mm && level >= b.level_mm;
    if (!within) continue;
    const span = BigInt(Math.abs(a.level_mm - b.level_mm));
    const off = BigInt(Math.abs(level - a.level_mm));
    const lerp = (x: number, y: number) => {
      const X = BigInt(x);
      const Y = BigInt(y);
      return Y >= X ? X + ceilDiv((Y - X) * off, span) : X - ((X - Y) * off) / span;
    };
    return { p: lerp(a.p_ppm, b.p_ppm), se: lerp(a.se_ppm, b.se_ppm) };
  }
  return null;
}

export interface Breakdown {
  p: bigint;
  se: bigint;
  margin: bigint;
  raw: bigint;
  rate: bigint;
  loadingPart: bigint;
  premium: (payout: bigint) => bigint;
  refused: boolean;
}

export function breakdown(p: bigint, se: bigint, params: EngineParams): Breakdown {
  let margin = ceilDiv(se * params.marginKBps, 10000n);
  if (margin < params.floorPpm) margin = params.floorPpm;
  const raw = p + margin;
  const rate = ceilDiv(raw * (10000n + params.loadingBps), 10000n);
  return {
    p,
    se,
    margin,
    raw,
    rate,
    loadingPart: rate - raw,
    premium: (payout) => ceilDiv(payout * rate, 1_000_000n),
    refused: rate > params.maxRatePpm,
  };
}
