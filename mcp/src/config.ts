import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";

const here = path.dirname(fileURLToPath(import.meta.url)); // mcp/src or mcp/dist
const repo = path.resolve(here, "../..");
const readJson = (p: string) => JSON.parse(readFileSync(path.join(repo, p), "utf8"));

export const deployment = readJson("contracts/deployments/arbitrum-sepolia.json");
export const data = readJson("data/generated/exceedance.json");

export const addr = {
  token: deployment.contracts.TestUSD as `0x${string}`,
  engine: deployment.contracts.DryspellEngine as `0x${string}`,
  vault: deployment.contracts.UnderwriterVault as `0x${string}`,
  oracle: deployment.contracts.WeatherOracle as `0x${string}`,
  book: deployment.contracts.PolicyBook as `0x${string}`,
};

export const RPC = process.env.DRYSPELL_RPC ?? "https://sepolia-rollup.arbitrum.io/rpc";
// Read-only: there is deliberately no wallet, key or signer anywhere in this server.
export const client = createPublicClient({ chain: arbitrumSepolia, transport: http(RPC) });

// ---- location / season helpers (locSeasonId = locationIndex * 10 + seasonIndex; tableId = locSeasonId * 2 + peril)
export interface SeasonInfo {
  loc: any;
  season: any;
  locSeasonId: number;
}
export const seasons: SeasonInfo[] = data.locations.flatMap((loc: any, li: number) => loc.seasons.map((season: any, si: number) => ({ loc, season, locSeasonId: li * 10 + si })));

export function findSeason(location: string, seasonId?: string): SeasonInfo {
  const q = location.trim().toLowerCase();
  const matches = seasons.filter((s) => s.loc.id === q || s.loc.name.toLowerCase() === q);
  if (!matches.length) throw new Error(`Unknown location "${location}". Known: ${data.locations.map((l: any) => l.id).join(", ")}`);
  if (seasonId) {
    const m = matches.find((s) => s.season.id === seasonId.toLowerCase());
    if (!m) throw new Error(`Unknown season "${seasonId}" for ${location}. Known: ${matches.map((s) => s.season.id).join(", ")}`);
    return m;
  }
  return matches.find((s) => s.season.perils.some((p: any) => p.offered)) ?? matches[0];
}

export const perilIndex = (p: "drought" | "flood") => (p === "drought" ? 0 : 1);
export const tableIdOf = (s: SeasonInfo, p: "drought" | "flood") => s.locSeasonId * 2 + perilIndex(p);
export const roundIdOf = (s: SeasonInfo, year: number) => (BigInt(s.locSeasonId) << 16n) | BigInt(year);

const md = (s: string) => s.split("-").map(Number) as [number, number];
export function seasonWindow(s: SeasonInfo, year: number): [number, number] {
  const [sm, sd] = md(s.season.start);
  const [em, ed] = md(s.season.end);
  const crosses = em < sm || (em === sm && ed < sd);
  return [Date.UTC(year, sm - 1, sd) / 1000, Date.UTC(crosses ? year + 1 : year, em - 1, ed) / 1000 + 86400];
}

/** first year whose purchase window (>= 14 days before start, <= 400 days ahead) is open now */
export function nextBuyableYear(s: SeasonInfo): number | null {
  const now = Math.floor(Date.now() / 1000);
  const y0 = new Date(now * 1000).getUTCFullYear();
  for (let y = y0; y <= y0 + 2; y++) {
    const [start] = seasonWindow(s, y);
    if (now + 14 * 86400 <= start && start <= now + 400 * 86400) return y;
  }
  return null;
}

export const usd = (v: bigint) => Number(v) / 1e6;
export const iso = (sec: number | bigint) => new Date(Number(sec) * 1000).toISOString();
export const ROUND_STATES = ["none", "proposed", "disputed", "final", "void"] as const;
export const POLICY_STATUS = ["", "active", "paid_out", "expired_no_payout", "refunded", "contested"] as const;
export const REGIONS = ["West Africa", "East Africa", "South Asia", "Southeast Asia"];
