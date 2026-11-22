// How often would the two sources have decided a trigger differently, season by season?
// Writes data/generated/disagreement.json and prints a report. Run: pnpm --filter @dryspell/data run disagree
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const j = JSON.parse(fs.readFileSync(path.join(root, "generated", "exceedance.json"), "utf8"));

const THRESHOLDS = [0.25, 0.4, 0.5, 0.75, 1.0]; // candidate max relative spreads
const out: any[] = [];
const spreadsAll: number[] = [];

for (const loc of j.locations) {
  for (const s of loc.seasons) {
    for (const p of s.perils) {
      const drought = p.peril === "drought";
      const ce = p.calibration_era5_ppm / 1e6;
      const cp = p.calibration_power_ppm / 1e6;
      const rows = s.history.map((h: any) => {
        const e = (drought ? h.total_era5_mm : h.max3_era5_mm) * ce;
        const w = (drought ? h.total_power_mm : h.max3_power_mm) * cp;
        const mean = (e + w) / 2;
        return { year: h.year, e, w, mean, spread: mean > 0 ? Math.abs(e - w) / mean : 0 };
      });
      rows.forEach((r: any) => spreadsAll.push(r.spread));
      const pays = (v: number, L: number) => (drought ? v <= L : v >= L);
      const perLevel = p.table.map((t: any) => {
        const opposite = rows.filter((r: any) => pays(r.e, t.level_mm) !== pays(r.w, t.level_mm)).length;
        return { level_mm: t.level_mm, p_ppm: t.p_ppm, opposite_seasons: opposite };
      });
      const med = (x: number[]) => [...x].sort((a, b) => a - b)[Math.floor(x.length / 2)];
      out.push({
        location: loc.id, season: s.id, peril: p.peril, offered: p.offered, seasons: rows.length,
        median_spread: Number(med(rows.map((r: any) => r.spread)).toFixed(3)),
        seasons_over_threshold: Object.fromEntries(THRESHOLDS.map((t) => [t, rows.filter((r: any) => r.spread > t).length])),
        per_level: perLevel,
      });
    }
  }
}
fs.writeFileSync(path.join(root, "generated", "disagreement.json"), JSON.stringify({ description: "Per location, season, peril and trigger level: number of seasons in which ERA5 alone and NASA POWER alone (each after calibration) fall on opposite sides of the trigger. Also, seasons whose calibrated readings differ by more than a relative spread.", thresholds: THRESHOLDS, entries: out }, null, 1) + "\n");

const all = [...spreadsAll].sort((a, b) => a - b);
const q = (f: number) => all[Math.floor(all.length * f)];
console.log("relative spread |era5-power|/mean of calibrated readings, all combos: p25", q(0.25).toFixed(2), "median", q(0.5).toFixed(2), "p75", q(0.75).toFixed(2), "p90", q(0.9).toFixed(2));
for (const t of THRESHOLDS) console.log(`  share of season-readings with spread > ${t}:`, (spreadsAll.filter((x) => x > t).length / spreadsAll.length * 100).toFixed(0) + "%");

console.log("\nOPPOSITE-SIDES COUNT per place (offered perils only), of 35 seasons, at three triggers:");
console.log("place/season/peril".padEnd(30), "p~3%".padStart(6), "p~10%".padStart(7), "p~25%".padStart(7), "avg over table".padStart(15));
for (const e of out.filter((x) => x.offered)) {
  const at = (target: number) => e.per_level.reduce((best: any, l: any) => Math.abs(l.p_ppm / 1e6 - target) < Math.abs(best.p_ppm / 1e6 - target) ? l : best).opposite_seasons;
  const avg = e.per_level.reduce((s: number, l: any) => s + l.opposite_seasons, 0) / e.per_level.length;
  console.log(`${e.location}/${e.season}/${e.peril}`.padEnd(30), String(at(0.03)).padStart(6), String(at(0.10)).padStart(7), String(at(0.25)).padStart(7), avg.toFixed(1).padStart(15));
}
const offered = out.filter((x) => x.offered);
const pool = (target: number) => offered.reduce((s, e) => s + e.per_level.reduce((b: any, l: any) => Math.abs(l.p_ppm / 1e6 - target) < Math.abs(b.p_ppm / 1e6 - target) ? l : b).opposite_seasons, 0) / (offered.length * 35);
console.log("\nacross all 16 offered covers: share of seasons with opposite sides at p~3%:", (pool(0.03) * 100).toFixed(1) + "%", " p~10%:", (pool(0.10) * 100).toFixed(1) + "%", " p~25%:", (pool(0.25) * 100).toFixed(1) + "%");
