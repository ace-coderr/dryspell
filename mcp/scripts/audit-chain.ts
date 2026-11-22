// Audit: compares every table point and calibration factor stored on chain with data/generated/exceedance.json,
// and checks that no config in the repo can point at a superseded deployment. Read-only.
//   pnpm --filter @dryspell/mcp exec tsx scripts/audit-chain.ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseAbi } from "viem";
import { addr, client, data, deployment } from "../src/config.js";

const engine = parseAbi(["function tablePoints(uint256) view returns (uint32[],uint32[],uint32[])", "function tableInfo(uint256) view returns (bool,bool,uint8,uint8)"]);
const oracle = parseAbi(["function calibration(uint256,uint8) view returns (bool,uint32,uint32)", "function seasons(uint256) view returns (bool,uint8,uint8,uint8,uint8)"]);

let bad = 0;
const fail = (m: string) => {
  bad++;
  console.log("MISMATCH:", m);
};
let tables = 0;
let cals = 0;
const REGION: Record<string, number> = { "West Africa": 0, "East Africa": 1, "South Asia": 2, "Southeast Asia": 3 };
for (const [li, loc] of data.locations.entries()) {
  for (const [si, s] of loc.seasons.entries()) {
    const id = li * 10 + si;
    const [exists, sm, sd, em, ed] = await client.readContract({ address: addr.oracle, abi: oracle, functionName: "seasons", args: [BigInt(id)] });
    const [a, b] = s.start.split("-").map(Number);
    const [c, d] = s.end.split("-").map(Number);
    if (!exists || sm !== a || sd !== b || em !== c || ed !== d) fail(`season window ${loc.id}/${s.id}`);
    for (const k of [0, 1]) {
      const p = s.perils[k];
      const [set, e, w] = await client.readContract({ address: addr.oracle, abi: oracle, functionName: "calibration", args: [BigInt(id), k] });
      if (!set || e !== p.calibration_era5_ppm || w !== p.calibration_power_ppm) fail(`calibration ${loc.id}/${s.id}/${p.peril}`);
      else cals++;
      const [tExists, enabled, region, peril] = await client.readContract({ address: addr.engine, abi: engine, functionName: "tableInfo", args: [BigInt(id * 2 + k)] });
      if (tExists !== p.offered) fail(`offered flag ${loc.id}/${s.id}/${p.peril}`);
      if (!p.offered) continue;
      if (!enabled || region !== REGION[loc.region] || peril !== k) fail(`table meta ${loc.id}/${s.id}/${p.peril}`);
      const [lv, pp, se] = await client.readContract({ address: addr.engine, abi: engine, functionName: "tablePoints", args: [BigInt(id * 2 + k)] });
      const same = lv.length === p.table.length && p.table.every((r: any, i: number) => r.level_mm === lv[i] && r.p_ppm === pp[i] && r.se_ppm === se[i]);
      if (!same) fail(`table points ${loc.id}/${s.id}/${p.peril}`);
      else tables++;
    }
  }
}
console.log(`on-chain tables identical to the JSON: ${tables}/16, calibrations: ${cals}/28, mismatches: ${bad}`);

// ---- stale deployment references
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stale = new Set<string>();
for (const f of readdirSync(path.join(root, "contracts/deployments")).filter((n) => n.endsWith("-superseded.json")).map((n) => "contracts/deployments/" + n)) {
  const j = JSON.parse(readFileSync(path.join(root, f), "utf8"));
  Object.values(j.contracts as Record<string, string>).forEach((a) => stale.add(a.toLowerCase()));
}
const live = new Set(Object.values(deployment.contracts as Record<string, string>).map((a) => a.toLowerCase()));
for (const a of live) if (stale.has(a)) fail(`live address ${a} is listed as superseded`);
console.log(`superseded addresses tracked: ${stale.size}, live addresses: ${live.size}, overlap: ${[...live].filter((a) => stale.has(a)).length}`);

const hits: string[] = [];
const skip = new Set(["node_modules", ".git", "broadcast", "cache", "out", "lib", "target", "dist"]);
const walk = (dir: string) => {
  for (const n of readdirSync(dir)) {
    if (skip.has(n)) continue;
    const p = path.join(dir, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(ts|tsx|json|md|sol|rs|sh|yml|html|css|js)$/.test(n) && !n.includes("superseded")) {
      const t = readFileSync(p, "utf8").toLowerCase();
      for (const a of stale) if (t.includes(a)) hits.push(path.relative(root, p));
    }
  }
};
walk(root);
const builtDist = path.join(root, "web/dist");
try {
  statSync(builtDist);
  const walkDist = (dir: string) => {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) walkDist(p);
      else if (/\.(js|json|html)$/.test(n)) {
        const t = readFileSync(p, "utf8").toLowerCase();
        for (const a of stale) if (t.includes(a)) hits.push(path.relative(root, p));
      }
    }
  };
  walkDist(builtDist);
} catch {
  /* no build yet */
}
console.log("files outside the superseded records that mention a v1/v2 address:", hits.length ? hits : "none");
if (hits.length) bad++;
process.exit(bad ? 1 : 0);
