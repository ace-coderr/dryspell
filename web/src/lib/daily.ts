import type { Season } from "./data";

export interface Daily {
  id: string;
  start: string;
  era5: number[];
  power: number[];
}

const cache = new Map<string, Promise<Daily>>();
export const loadDaily = (locId: string): Promise<Daily> => {
  if (!cache.has(locId)) {
    cache.set(
      locId,
      fetch(`${import.meta.env.BASE_URL}data/daily/${locId}.json`).then((r) => {
        if (!r.ok) throw new Error(`rainfall history for ${locId} failed to load (${r.status})`);
        return r.json();
      }),
    );
  }
  return cache.get(locId)!;
};

const T0 = Date.UTC(1991, 0, 1);
const dayIdx = (y: number, m: number, d: number) => Math.round((Date.UTC(y, m - 1, d) - T0) / 86400000);

/** daily series of both sources for one season-year, or null if outside the stored history */
export function seasonSlice(d: Daily, s: Season, year: number): { era5: number[]; power: number[]; startDate: string } | null {
  const [sm, sd] = s.start.split("-").map(Number);
  const [em, ed] = s.end.split("-").map(Number);
  const a = dayIdx(year, sm, sd);
  const b = dayIdx(s.crosses_new_year ? year + 1 : year, em, ed);
  if (a < 0 || b >= d.era5.length) return null;
  return { era5: d.era5.slice(a, b + 1), power: d.power.slice(a, b + 1), startDate: `${year}-${s.start}` };
}
