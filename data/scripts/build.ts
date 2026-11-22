// Builds per-location, per-season exceedance tables from the real daily data
// written by fetch.ts.  Output: data/generated/exceedance.json
//
// Settlement variable (what a Dryspell policy is judged on):
//   drought: season rainfall total (mm)            -> pays when total <= trigger
//   flood:   max rolling 3-day rainfall in season  -> pays when max3 >= trigger
// Each source computes the statistic separately; the settlement value is the
// median of the two source readings (= their mean, with two sources).
//
// Run:  pnpm --filter @dryspell/data build

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOCATIONS, PERIOD, SOURCES, type SeasonDef } from "./config.ts";
import {
  fitGamma,
  fitGumbel,
  gammaCdf,
  gumbelCdf,
  hashString,
  invertCdf,
  ksDistance,
  mean,
  mulberry32,
  pearson,
  stdev,
} from "./stats.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dailyDir = path.join(root, "generated", "daily");

const BOOTSTRAPS = 500;
// Calibration uses ONLY seasons up to this year. The oracle refuses rounds before 2020, so no season that can
// ever be reported or settled contributes to its own calibration (no look-ahead). Forward seasons (2027+)
// are likewise out of sample. The pricing fit below still uses all seasons; see data/README.md.
const CALIBRATION_END_YEAR = 2019;
// A peril is only offered where the two sources agree on the year-to-year signal
const MIN_CORRELATION = 0.4;
// Probabilities at which the table levels are placed (tail-heavy: that is where cover is bought)
const GRID = [0.005, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.075, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5];

type Peril = "drought" | "flood";

interface Daily {
  start: string;
  era5: (number | null)[];
  power: (number | null)[];
}

const dayIndex = (y: number, m: number, d: number) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(PERIOD.startYear, 0, 1)) / 86400000);
const md = (s: string) => s.split("-").map(Number) as [number, number];

interface SeasonStat {
  year: number; // year the season starts
  total: [number, number]; // [era5, power] mm
  max3: [number, number];
}

function seasonStats(d: Daily, s: SeasonDef): SeasonStat[] {
  const [sm, sd] = md(s.start);
  const [em, ed] = md(s.end);
  const crosses = em < sm || (em === sm && ed < sd);
  const n = d.era5.length;
  const out: SeasonStat[] = [];
  for (let y = PERIOD.startYear; y <= PERIOD.endYear; y++) {
    const a = dayIndex(y, sm, sd);
    const b = dayIndex(crosses ? y + 1 : y, em, ed);
    if (b >= n) continue;
    const total: number[] = [];
    const max3: number[] = [];
    for (const series of [d.era5, d.power]) {
      let t = 0;
      let m = 0;
      for (let i = a; i <= b; i++) {
        const v = series[i];
        if (v === null) throw new Error("missing value inside a season; handle before building");
        t += v;
        if (i - 2 >= a) m = Math.max(m, series[i]! + series[i - 1]! + series[i - 2]!);
      }
      total.push(t);
      max3.push(m);
    }
    out.push({ year: y, total: [total[0], total[1]], max3: [max3[0], max3[1]] });
  }
  return out;
}

interface Dist {
  cdf: (x: number) => number; // P(X <= x)
  params: Record<string, number>;
}

function fit(peril: Peril, xs: number[]): Dist {
  if (peril === "drought") {
    const g = fitGamma(xs);
    return { cdf: (x) => gammaCdf(g, x), params: { shape: g.shape, scale: g.scale } };
  }
  const g = fitGumbel(xs);
  return { cdf: (x) => gumbelCdf(g, x), params: { loc: g.loc, scale: g.scale } };
}

// probability the policy pays at trigger level L for a fitted distribution
const payProb = (peril: Peril, dist: Dist, L: number) => (peril === "drought" ? dist.cdf(L) : 1 - dist.cdf(L));
const pays = (peril: Peril, v: number, L: number) => (peril === "drought" ? v <= L : v >= L);
const ppm = (p: number) => Math.round(p * 1e6);

function tableFor(locId: string, seasonId: string, peril: Peril, stats: SeasonStat[]) {
  const pick = (s: SeasonStat) => (peril === "drought" ? s.total : s.max3);
  const eRaw = stats.map((s) => pick(s)[0]);
  const pRaw = stats.map((s) => pick(s)[1]);
  const n = eRaw.length;

  // Per-source calibration: scale each source so both share the pooled long-run mean.
  // Factors are published (ppm) so the settlement is reproducible by anyone from the raw readings.
  const calIdx = stats.map((x, i) => (x.year <= CALIBRATION_END_YEAR ? i : -1)).filter((i) => i >= 0);
  const mE = mean(calIdx.map((i) => eRaw[i]));
  const mP = mean(calIdx.map((i) => pRaw[i]));
  const mPool = (mE + mP) / 2;
  const calE = Math.round((mPool / mE) * 1e6);
  const calP = Math.round((mPool / mP) * 1e6);
  const e = eRaw.map((v) => (v * calE) / 1e6);
  const p = pRaw.map((v) => (v * calP) / 1e6);
  const settle = e.map((v, i) => (v + p[i]) / 2);
  const corr = pearson(eRaw, pRaw);

  const main = fit(peril, settle);
  const fe = fit(peril, e);
  const fp = fit(peril, p);

  // Levels: whole-mm values where the fitted pay probability hits the grid.
  const levels: number[] = [];
  const hi = Math.max(...settle) * 4 + 50;
  for (const q of GRID) {
    // drought pays when X <= L, so L is the q-quantile; flood pays when X >= L, so L is the (1-q)-quantile
    const target = peril === "drought" ? q : 1 - q;
    const L = Math.round(invertCdf(main.cdf, target, 0, hi));
    if (L >= 1 && !levels.includes(L)) levels.push(L);
  }
  levels.sort((a, b) => (peril === "drought" ? a - b : b - a));

  // bootstrap the blended fit over years (same resampled years for both sources)
  const rnd = mulberry32(hashString(`${locId}/${seasonId}/${peril}`));
  const samples: number[][] = levels.map(() => []);
  for (let b = 0; b < BOOTSTRAPS; b++) {
    const idx = Array.from({ length: n }, () => Math.floor(rnd() * n));
    const d = fit(
      peril,
      idx.map((i) => settle[i]),
    );
    levels.forEach((L, k) => samples[k].push(payProb(peril, d, L)));
  }

  const rows = levels.map((L, k) => {
    const emp = settle.filter((v) => pays(peril, v, L)).length / n;
    const split = stats.filter((_, i) => pays(peril, e[i], L) !== pays(peril, p[i], L)).length / n;
    return {
      level_mm: L,
      p_ppm: ppm(payProb(peril, main, L)), // price from this
      p_era5_ppm: ppm(payProb(peril, fe, L)),
      p_power_ppm: ppm(payProb(peril, fp, L)),
      p_empirical_ppm: ppm(emp),
      se_ppm: ppm(stdev(samples[k])),
      source_split_ppm: ppm(split),
    };
  });

  return {
    peril,
    distribution: peril === "drought" ? "gamma" : "gumbel",
    params: Object.fromEntries(Object.entries(main.params).map(([k, v]) => [k, Number(v.toFixed(4))])),
    ks_distance: Number(ksDistance(settle, main.cdf).toFixed(4)),
    settlement_mean_mm: Number(mean(settle).toFixed(1)),
    settlement_stdev_mm: Number(stdev(settle).toFixed(1)),
    calibration_years: `${stats[0].year}-${CALIBRATION_END_YEAR}`,
    calibration_seasons: calIdx.length,
    calibration_era5_ppm: calE,
    calibration_power_ppm: calP,
    source_correlation: Number(corr.toFixed(3)),
    source_mean_bias_mm: Number((mP - mE).toFixed(1)), // raw: POWER minus ERA5
    source_mean_abs_diff_mm: Number(mean(e.map((v, i) => Math.abs(v - p[i]))).toFixed(1)), // after calibration
    agreement: corr >= 0.6 ? "high" : corr >= MIN_CORRELATION ? "medium" : "low",
    offered: corr >= MIN_CORRELATION,
    table: rows,
  };
}

const locations = LOCATIONS.map((loc) => {
  const daily = JSON.parse(fs.readFileSync(path.join(dailyDir, `${loc.id}.json`), "utf8")) as Daily;
  const seasons = loc.seasons.map((s) => {
    const stats = seasonStats(daily, s);
    const perils = (["drought", "flood"] as const).map((peril) => tableFor(loc.id, s.id, peril, stats));
    const [dr, fl] = perils;
    const settle = (a: number, b: number, c: { calibration_era5_ppm: number; calibration_power_ppm: number }) =>
      Number(((a * c.calibration_era5_ppm + b * c.calibration_power_ppm) / 2e6).toFixed(1));
    return {
      id: s.id,
      name: s.name,
      start: s.start,
      end: s.end,
      crosses_new_year: md(s.end)[0] < md(s.start)[0],
      years: stats.length,
      history: stats.map((x) => ({
        year: x.year,
        total_era5_mm: Number(x.total[0].toFixed(1)),
        total_power_mm: Number(x.total[1].toFixed(1)),
        max3_era5_mm: Number(x.max3[0].toFixed(1)),
        max3_power_mm: Number(x.max3[1].toFixed(1)),
        total_settle_mm: settle(x.total[0], x.total[1], dr),
        max3_settle_mm: settle(x.max3[0], x.max3[1], fl),
      })),
      perils,
    };
  });
  return { id: loc.id, name: loc.name, country: loc.country, region: loc.region, lat: loc.lat, lon: loc.lon, note: loc.note, seasons };
});

const fetchLog = JSON.parse(fs.readFileSync(path.join(root, "generated", "fetch-log.json"), "utf8"));

const out = {
  meta: {
    description:
      "Exceedance tables for Dryspell parametric weather cover, derived from real daily precipitation history.",
    period: `${PERIOD.startYear}-01-01 to ${PERIOD.endYear}-12-31`,
    data_accessed: fetchLog.accessed,
    sources: SOURCES,
    settlement:
      "Each source computes the season statistic independently. Each reading is multiplied by its published calibration factor (calibration_*_ppm / 1e6) and the settlement value is the median (mean of the two) of the calibrated readings.",
    calibration:
      "Raw ERA5 and NASA POWER rainfall differ structurally (up to 2x in some places). Rule: for each location, season and peril, factor_source = pooled_mean / source_mean, where source_mean is that source's mean of the season statistic over 1991-2019 only and pooled_mean = (era5_mean + power_mean) / 2. No season from 2020 on, and no forward season, takes part in its own calibration. Factors are fixed at deployment (write-once on-chain) and apply to every year.",
    offering_rule:
      "A peril is offered only where the two sources' season statistics correlate at or above " +
      MIN_CORRELATION +
      "; below that the oracle would mostly average noise. Non-offered tables are kept for transparency (offered: false).",
    perils: {
      drought: "Pays when the season rainfall total is at or below the trigger (mm).",
      flood: "Pays when the maximum rolling 3-day rainfall within the season is at or above the trigger (mm).",
    },
    fields: {
      level_mm: "Trigger level in whole mm.",
      calibration_era5_ppm: "Multiplier (parts per million) applied to the raw ERA5 reading before the median.",
      calibration_power_ppm: "Multiplier (parts per million) applied to the raw NASA POWER reading before the median.",
      p_ppm: "Fitted probability (parts per million) that the settlement value crosses the level in a season. Used for pricing.",
      p_era5_ppm: "Same, fitted to the ERA5 series alone.",
      p_power_ppm: "Same, fitted to the NASA POWER series alone.",
      p_empirical_ppm: "Raw historical frequency of the settlement value crossing the level (no smoothing).",
      se_ppm: `Standard error of p_ppm from ${BOOTSTRAPS} bootstrap resamples of the seasons. Used for the risk margin.`,
      source_split_ppm: "Share of seasons in which exactly one of the two sources would have triggered (dispute-prone cases).",
    },
    method: {
      drought: "Gamma distribution, maximum-likelihood fit (Thom approximation) on season totals.",
      flood: "Gumbel distribution, L-moment fit on seasonal maximum 3-day rainfall.",
      levels: "Whole-mm trigger levels placed where the fitted probability equals each grid point.",
      grid: GRID,
      bootstraps: BOOTSTRAPS,
      caveats: [
        "About 35 seasons per place: tail probabilities carry real sampling error (see se_ppm).",
        "Stationary climate assumed; no trend or ENSO conditioning.",
        "Reanalysis and satellite-blend grids are tens of kilometres wide; they miss local convective extremes (basis risk).",
      ],
    },
  },
  locations,
};

const file = path.join(root, "generated", "exceedance.json");
fs.writeFileSync(file, JSON.stringify(out, null, 1) + "\n");

// Console report for sanity checks
for (const l of locations) {
  for (const s of l.seasons) {
    const dr = s.perils[0];
    const fl = s.perils[1];
    const tag = (x: { offered: boolean }) => (x.offered ? "OFFER" : "skip ");
    console.log(
      `${l.name.padEnd(9)} ${s.id.padEnd(8)} n=${s.years} total ${dr.settlement_mean_mm}±${dr.settlement_stdev_mm}mm KS ${dr.ks_distance} r=${dr.source_correlation} ${tag(dr)} | max3 ${fl.settlement_mean_mm}±${fl.settlement_stdev_mm}mm KS ${fl.ks_distance} r=${fl.source_correlation} ${tag(fl)}`,
    );
  }
}
console.log(`wrote ${path.relative(process.cwd(), file)} (${(fs.statSync(file).size / 1024).toFixed(0)} kB)`);
