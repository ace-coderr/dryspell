export const USD_DECIMALS = 6;

export function fmtUsd(v: bigint | number, digits = 2): string {
  const n = typeof v === "bigint" ? Number(v) / 1e6 : v;
  return n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export const parseUsd = (s: string): bigint => {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return 0n;
  return BigInt(Math.round(n * 1e6));
};

export const pct = (ppm: number | bigint, digits = 2) => `${(Number(ppm) / 1e4).toFixed(digits)}%`;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function errMessage(e: unknown): string {
  const m = (e as any)?.shortMessage ?? (e as any)?.message ?? String(e);
  return String(m).split("\n")[0].slice(0, 220);
}

export function countdown(sec: number): string {
  if (sec <= 0) return "now";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}
