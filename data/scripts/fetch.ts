// Pulls real daily precipitation history for every launch location from
//   1. Open-Meteo Historical Weather API (ECMWF ERA5 reanalysis)
//   2. NASA POWER daily point API (PRECTOTCORR)
// and writes data/generated/daily/<id>.json.  Raw responses are cached in
// data/.cache (gitignored) so reruns are cheap and polite.
//
// Run:  pnpm --filter @dryspell/data fetch

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCATIONS, PERIOD, type LocationDef } from "./config.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const cacheDir = path.join(root, ".cache");
const outDir = path.join(root, "generated", "daily");
fs.mkdirSync(cacheDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const START = `${PERIOD.startYear}-01-01`;
const END = `${PERIOD.endYear}-12-31`;
const UA = "dryspell-data-script (open-source hackathon project)";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string, tries = 6): Promise<unknown> {
  let wait = 3000;
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA } });
      if (res.ok) return await res.json();
      const body = (await res.text()).slice(0, 200);
      if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status}: ${body}`);
      console.warn(`  retry ${i}/${tries} after HTTP ${res.status}`);
    } catch (e) {
      if (i === tries) throw e;
      console.warn(`  retry ${i}/${tries}: ${(e as Error).message}`);
    }
    await sleep(wait);
    wait *= 2;
  }
  throw new Error("unreachable");
}

async function cached(name: string, url: string): Promise<any> {
  const f = path.join(cacheDir, name);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8"));
  const j = await getJson(url);
  fs.writeFileSync(f, JSON.stringify(j));
  return j;
}

function expectedDays(): number {
  const a = Date.UTC(PERIOD.startYear, 0, 1);
  const b = Date.UTC(PERIOD.endYear, 11, 31);
  return Math.round((b - a) / 86400000) + 1;
}

async function era5(loc: LocationDef): Promise<(number | null)[]> {
  const url =
    "https://archive-api.open-meteo.com/v1/archive" +
    `?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${START}&end_date=${END}` +
    "&daily=precipitation_sum&models=era5&timezone=UTC";
  const j = await cached(`${loc.id}.era5.json`, url);
  const v: (number | null)[] = j.daily.precipitation_sum;
  const t: string[] = j.daily.time;
  if (t[0] !== START || t[t.length - 1] !== END) throw new Error(`era5 ${loc.id}: unexpected date range ${t[0]}..${t[t.length - 1]}`);
  return v;
}

async function power(loc: LocationDef): Promise<(number | null)[]> {
  const url =
    "https://power.larc.nasa.gov/api/temporal/daily/point" +
    `?parameters=PRECTOTCORR&community=AG&longitude=${loc.lon}&latitude=${loc.lat}` +
    `&start=${START.replaceAll("-", "")}&end=${END.replaceAll("-", "")}&format=JSON`;
  const j = await cached(`${loc.id}.power.json`, url);
  const series: Record<string, number> = j.properties.parameter.PRECTOTCORR;
  const keys = Object.keys(series).sort();
  if (keys[0] !== START.replaceAll("-", "") || keys[keys.length - 1] !== END.replaceAll("-", "")) {
    throw new Error(`power ${loc.id}: unexpected date range ${keys[0]}..${keys[keys.length - 1]}`);
  }
  // POWER marks missing values as -999
  return keys.map((k) => (series[k] <= -990 ? null : series[k]));
}

const r2 = (x: number | null) => (x === null ? null : Math.round(x * 100) / 100);

const n = expectedDays();
const accessed = new Date().toISOString().slice(0, 10);
const summary: Record<string, unknown>[] = [];

for (const loc of LOCATIONS) {
  console.log(`${loc.name}, ${loc.country}`);
  const a = await era5(loc);
  await sleep(1500);
  const b = await power(loc);
  await sleep(1500);
  if (a.length !== n || b.length !== n) throw new Error(`${loc.id}: expected ${n} days, got era5=${a.length} power=${b.length}`);
  const missA = a.filter((x) => x === null).length;
  const missB = b.filter((x) => x === null).length;
  fs.writeFileSync(
    path.join(outDir, `${loc.id}.json`),
    JSON.stringify({
      id: loc.id,
      start: START,
      end: END,
      unit: "mm/day",
      era5: a.map(r2),
      power: b.map(r2),
    }),
  );
  console.log(`  ${n} days; missing era5=${missA} power=${missB}`);
  summary.push({ id: loc.id, days: n, missingEra5: missA, missingPower: missB });
}

fs.writeFileSync(
  path.join(root, "generated", "fetch-log.json"),
  JSON.stringify({ accessed, start: START, end: END, locations: summary }, null, 2) + "\n",
);
console.log(`done, accessed ${accessed}`);
