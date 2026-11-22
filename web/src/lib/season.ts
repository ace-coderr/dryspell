import type { Season } from "./data";

const md = (s: string) => s.split("-").map(Number) as [number, number];

/** unix seconds of 00:00 UTC on the first day and just after the last day (matches SeasonCalendar.sol) */
export function seasonWindow(s: Season, year: number): [number, number] {
  const [sm, sd] = md(s.start);
  const [em, ed] = md(s.end);
  const crosses = em < sm || (em === sm && ed < sd);
  const start = Date.UTC(year, sm - 1, sd) / 1000;
  const end = Date.UTC(crosses ? year + 1 : year, em - 1, ed) / 1000 + 86400;
  return [start, end];
}

export const LEAD_TIME = 14 * 86400;
export const MAX_HORIZON = 400 * 86400;

/** first season year whose purchase window is open now (>= 14 days before it starts, <= 400 days) */
export function nextBuyableYear(s: Season, nowSec = Math.floor(Date.now() / 1000)): number | null {
  const y0 = new Date(nowSec * 1000).getUTCFullYear();
  for (let y = y0; y <= y0 + 2; y++) {
    const [start] = seasonWindow(s, y);
    if (nowSec + LEAD_TIME <= start && start <= nowSec + MAX_HORIZON) return y;
  }
  return null;
}

export const fmtDate = (sec: number) =>
  new Date(sec * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export const fmtDateTime = (sec: number) =>
  new Date(sec * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
