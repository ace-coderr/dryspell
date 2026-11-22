// Live readings from the two public sources, fetched straight from the browser.
export interface Reading {
  days: number;
  total: number; // mm
  max3: number; // mm, maximum rolling 3-day sum
  lastDate: string;
}

const iso = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

function summarise(dates: string[], mm: (number | null)[]): Reading | null {
  const pts = dates.map((d, i) => ({ d, v: mm[i] })).filter((p) => p.v !== null && p.v !== undefined && (p.v as number) > -990) as { d: string; v: number }[];
  if (!pts.length) return null;
  let total = 0;
  let max3 = 0;
  pts.forEach((p, i) => {
    total += p.v;
    if (i >= 2) max3 = Math.max(max3, p.v + pts[i - 1].v + pts[i - 2].v);
  });
  return { days: pts.length, total, max3, lastDate: pts[pts.length - 1].d };
}

/** ECMWF ERA5 via Open-Meteo (CC BY 4.0, non-commercial free tier) */
export async function fetchEra5(lat: number, lon: number, startSec: number, endSec: number): Promise<Reading | null> {
  const url = `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&start_date=${iso(startSec)}&end_date=${iso(endSec)}&daily=precipitation_sum&models=era5&timezone=UTC`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Open-Meteo answered ${r.status}`);
  const j = await r.json();
  return summarise(j.daily.time, j.daily.precipitation_sum);
}

/** NASA POWER daily point API, bias-corrected precipitation */
export async function fetchPower(lat: number, lon: number, startSec: number, endSec: number): Promise<Reading | null> {
  const f = (s: number) => iso(s).replaceAll("-", "");
  const url = `https://power.larc.nasa.gov/api/temporal/daily/point?parameters=PRECTOTCORR&community=AG&longitude=${lon}&latitude=${lat}&start=${f(startSec)}&end=${f(endSec)}&format=JSON`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`NASA POWER answered ${r.status}`);
  const j = await r.json();
  const series: Record<string, number> = j.properties.parameter.PRECTOTCORR;
  const keys = Object.keys(series).sort();
  return summarise(keys.map((k) => `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6)}`), keys.map((k) => series[k]));
}
