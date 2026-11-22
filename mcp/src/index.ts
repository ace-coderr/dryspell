#!/usr/bin/env node
// Dryspell MCP server (read-only). Speaks MCP over stdio. Reads the live contracts on Arbitrum Sepolia.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { bookAbi, engineAbi, oracleAbi, vaultAbi } from "./abi.js";
import {
  POLICY_STATUS, REGIONS, ROUND_STATES, addr, client, data, deployment, findSeason, iso, nextBuyableYear, roundIdOf, seasonWindow, seasons, tableIdOf, usd,
} from "./config.js";

const server = new McpServer({ name: "dryspell", version: "0.1.0" });
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;
const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) }] });
const HINTS: Record<string, string> = {
  RoundAlreadyReporting: "This season's oracle round already has a report (or is final), so no new cover can be bought on it.",
  TooLate: "Too late to buy: cover must be bought at least 14 days before the season starts (the waiting period).",
  TooEarlyToBuy: "Too early: cover can be bought at most 400 days before the season starts.",
  OutOfRange: "The trigger is outside the range the pricing table covers for this place and peril.",
  RateTooHigh: "The engine refuses this cover: the price would exceed its rate cap (the odds of paying out are too high).",
  UnknownTable: "No pricing table is loaded for this place, season and peril (it is not offered).",
  TableDisabled: "Selling cover on this table is switched off.",
  UnknownSeason: "This season is not defined on-chain.",
  YearOutOfRange: "The year must be 2020 or later.",
};
const fail = (e: unknown) => {
  // viem decodes custom errors into e.data.errorName somewhere down the cause chain
  let name = "";
  for (let x: any = e; x && !name; x = x.cause) name = x?.data?.errorName ?? "";
  const raw = name + " " + String((e as any)?.shortMessage ?? (e as Error).message ?? e);
  const hint = Object.entries(HINTS).find(([k]) => raw.includes(k))?.[1];
  const firstLine = raw.split(String.fromCharCode(10))[0];
  return { isError: true, content: [{ type: "text" as const, text: `Error: ${hint ?? firstLine}` }] };
};
const guard = <A,>(fn: (a: A) => Promise<unknown>) => async (a: A) => {
  try {
    return text(await fn(a));
  } catch (e) {
    return fail(e);
  }
};
const peril = z.enum(["drought", "flood"]);

// -------------------------------------------------------------------- quote_cover
server.registerTool(
  "quote_cover",
  {
    title: "Quote a weather cover",
    description:
      "Price a parametric weather cover exactly as the on-chain engine would, from the live contract. Drought pays if the season rainfall total is at or below the trigger; flood pays if the maximum 3-day rainfall in the season is at or above it. Returns the premium, the fitted odds, the uncertainty margin, and whether the season is a Replay (a finished historical season on the test network). Does not buy anything.",
    inputSchema: {
      location: z.string().describe("Location id or name, e.g. 'jodhpur' or 'Garissa'"),
      season: z.string().optional().describe("Season id when a place has several, e.g. 'short' or 'long'"),
      peril,
      trigger_mm: z.number().int().positive().describe("Trigger in whole millimetres"),
      payout_tusd: z.number().positive().describe("Payout in TestUSD (testnet play money)"),
      year: z.number().int().optional().describe("Season year. Defaults to the next season that can still be bought (at least 14 days before it starts)."),
    },
    annotations: READ_ONLY,
  },
  guard(async (a: { location: string; season?: string; peril: "drought" | "flood"; trigger_mm: number; payout_tusd: number; year?: number }) => {
    const s = findSeason(a.location, a.season);
    const pd = s.season.perils[a.peril === "drought" ? 0 : 1];
    const year = a.year ?? nextBuyableYear(s);
    if (!year) throw new Error(`No purchase window is open for ${s.loc.name} ${s.season.name} right now (cover must be bought 14 to 400 days before the season starts). Pass an explicit year to quote a past season on a replay round.`);
    if (!pd.offered) return { offered: false, reason: `${a.peril} cover is not offered for ${s.loc.name} · ${s.season.name}: the two weather sources correlate at only ${pd.source_correlation}, below the 0.40 bar.` };
    const payout = BigInt(Math.round(a.payout_tusd * 1e6));
    const [premium, p, se, rate, replay] = await client.readContract({ address: addr.book, abi: bookAbi, functionName: "quote", args: [BigInt(tableIdOf(s, a.peril)), BigInt(year), BigInt(a.trigger_mm), payout] });
    const [start, end] = seasonWindow(s, year);
    return {
      location: `${s.loc.name}, ${s.loc.country}`,
      season: s.season.name,
      year,
      peril: a.peril,
      label: replay ? "Replay (historical season on the test network, not a live forward season)" : "live forward season",
      trigger_mm: a.trigger_mm,
      pays_when: a.peril === "drought" ? `season rainfall total <= ${a.trigger_mm} mm` : `max 3-day rainfall >= ${a.trigger_mm} mm`,
      payout_tusd: usd(payout),
      premium_tusd: usd(premium),
      premium_pct_of_payout: Number(rate) / 1e4,
      fitted_chance_per_season_pct: Number(p) / 1e4,
      uncertainty_se_pct: Number(se) / 1e4,
      season_window_utc: { start: iso(start), end_exclusive: iso(end) },
      engine: await client.readContract({ address: addr.book, abi: bookAbi, functionName: "engineKind" }),
      note: "Quote only. This server is read-only and cannot buy. Testnet play money.",
    };
  }),
);

// -------------------------------------------------------------------- list_policies
server.registerTool(
  "list_policies",
  {
    title: "List policies",
    description: "List Dryspell policies from the PolicyBook contract with status (active, paid_out, expired_no_payout, refunded, contested), trigger, payout, premium and whether each is a Replay.",
    inputSchema: {
      holder: z.string().optional().describe("Only policies held by this address"),
      status: z.enum(["active", "paid_out", "expired_no_payout", "refunded", "contested"]).optional(),
      limit: z.number().int().min(1).max(200).default(50),
    },
    annotations: READ_ONLY,
  },
  guard(async (a: { holder?: string; status?: string; limit: number }) => {
    const count = Number(await client.readContract({ address: addr.book, abi: bookAbi, functionName: "policyCount" }));
    const ids = Array.from({ length: count }, (_, i) => BigInt(i + 1));
    const reads = await client.multicall({ contracts: ids.map((id) => ({ address: addr.book, abi: bookAbi, functionName: "getPolicy", args: [id] }) as const), allowFailure: false });
    const rounds = reads.map((p) => (BigInt(Math.floor(Number(p.tableId) / 2)) << 16n) | BigInt(p.year));
    const replay = await client.multicall({ contracts: rounds.map((r) => ({ address: addr.oracle, abi: oracleAbi, functionName: "isReplay", args: [r] }) as const), allowFailure: false });
    let rows = reads.map((p, i) => {
      const s = seasons.find((x) => x.locSeasonId === Math.floor(Number(p.tableId) / 2));
      const pr = Number(p.tableId) % 2 === 0 ? "drought" : "flood";
      return {
        id: i + 1,
        cover: s ? `${s.loc.name} · ${s.season.name}` : `season ${Math.floor(Number(p.tableId) / 2)}`,
        year: Number(p.year),
        peril: pr,
        trigger_mm: Number(p.trigger),
        pays_when: pr === "drought" ? `<= ${p.trigger} mm` : `>= ${p.trigger} mm`,
        payout_tusd: usd(p.payout),
        premium_tusd: usd(p.premium),
        status: POLICY_STATUS[Number(p.status)],
        replay: replay[i],
        label: replay[i] ? "Replay" : "live season",
        holder: p.holder,
      };
    });
    if (a.holder) rows = rows.filter((r) => r.holder.toLowerCase() === a.holder!.toLowerCase());
    if (a.status) rows = rows.filter((r) => r.status === a.status);
    return { total_policies: count, returned: Math.min(rows.length, a.limit), policies: rows.slice(-a.limit).reverse() };
  }),
);

// -------------------------------------------------------------------- read_vault
server.registerTool(
  "read_vault",
  {
    title: "Read underwriter vault state",
    description: "Underwriter pool state: total assets, locked collateral, utilisation, share value (yield net of payouts), exposure against the cap for every region and peril, and which engine (Stylus or the Solidity fallback) prices and caps the book.",
    inputSchema: {},
    annotations: READ_ONLY,
  },
  guard(async () => {
    const [assets, locked, util, price, minHold, kind, params, exposure] = await Promise.all([
      client.readContract({ address: addr.vault, abi: vaultAbi, functionName: "totalAssets" }),
      client.readContract({ address: addr.vault, abi: vaultAbi, functionName: "lockedAssets" }),
      client.readContract({ address: addr.vault, abi: vaultAbi, functionName: "utilizationBps" }),
      client.readContract({ address: addr.vault, abi: vaultAbi, functionName: "convertToAssets", args: [1_000_000_000n] }),
      client.readContract({ address: addr.vault, abi: vaultAbi, functionName: "minHold" }),
      client.readContract({ address: addr.engine, abi: engineAbi, functionName: "engineKind" }),
      client.readContract({ address: addr.engine, abi: engineAbi, functionName: "params" }),
      client.readContract({ address: addr.engine, abi: engineAbi, functionName: "totalExposure" }),
    ]);
    const cells = await client.multicall({
      contracts: REGIONS.flatMap((_, r) => [0, 1].flatMap((p) => [{ address: addr.engine, abi: engineAbi, functionName: "exposureOf", args: [r, p] } as const, { address: addr.engine, abi: engineAbi, functionName: "capBpsOf", args: [r, p] } as const])),
      allowFailure: false,
    });
    const matrix = REGIONS.flatMap((region, r) =>
      ["drought", "flood"].map((pr, p) => {
        const e = cells[(r * 2 + p) * 2] as bigint;
        const cap = cells[(r * 2 + p) * 2 + 1] as bigint;
        const capAbs = (assets * cap) / 10000n;
        return { region, peril: pr, exposure_tusd: usd(e), cap_pct_of_pool: Number(cap) / 100, cap_tusd: usd(capAbs), used_pct: capAbs > 0n ? Number((e * 10000n) / capAbs) / 100 : 0 };
      }),
    );
    return {
      engine_mode: kind,
      engine_note: kind === "stylus" ? "Rust/WASM engine on Arbitrum Stylus" : "Solidity fallback engine (Stylus activation was paused on Arbitrum Sepolia)",
      total_assets_tusd: usd(assets),
      locked_collateral_tusd: usd(locked),
      free_tusd: usd(assets - locked),
      total_exposure_tusd: usd(exposure),
      utilisation_pct: Number(util) / 100,
      utilisation_hard_cap_pct: Number(params[4]) / 100,
      share_value_tusd: Number(price) / 1e6,
      yield_since_launch_pct: (Number(price) / 1e6 - 1) * 100,
      withdrawal_hold_hours: Number(minHold) / 3600,
      exposure_by_region_and_peril: matrix,
      contracts: deployment.contracts,
    };
  }),
);

// -------------------------------------------------------------------- read_trigger_status
server.registerTool(
  "read_trigger_status",
  {
    title: "Read oracle trigger status for a season",
    description: "Where a covered season stands: oracle state (none, proposed, disputed, final, void), report and dispute-window times, the readings from both weather sources if posted, the final settlement values, the allowed spread between sources, and how much cover is outstanding. Flags Replay rounds.",
    inputSchema: {
      location: z.string(),
      season: z.string().optional(),
      year: z.number().int().describe("Season year, 2020 or later"),
    },
    annotations: READ_ONLY,
  },
  guard(async (a: { location: string; season?: string; year: number }) => {
    const s = findSeason(a.location, a.season);
    const rid = roundIdOf(s, a.year);
    const [round, isReplay, ends, rEnds, from, deadline, bond, spread, exposure, resolver] = await Promise.all([
      client.readContract({ address: addr.oracle, abi: oracleAbi, functionName: "getRound", args: [rid] }),
      client.readContract({ address: addr.oracle, abi: oracleAbi, functionName: "isReplay", args: [rid] }),
      client.readContract({ address: addr.oracle, abi: oracleAbi, functionName: "challengeEndsAt", args: [rid] }),
      client.readContract({ address: addr.oracle, abi: oracleAbi, functionName: "resolverDeadline", args: [rid] }),
      client.readContract({ address: addr.oracle, abi: oracleAbi, functionName: "reportableFrom", args: [BigInt(s.locSeasonId), BigInt(a.year)] }),
      client.readContract({ address: addr.oracle, abi: oracleAbi, functionName: "reportDeadline", args: [rid] }),
      client.readContract({ address: addr.oracle, abi: oracleAbi, functionName: "requiredBond", args: [rid] }),
      client.readContract({ address: addr.oracle, abi: oracleAbi, functionName: "maxSpreadBps" }),
      client.readContract({ address: addr.book, abi: bookAbi, functionName: "roundExposure", args: [rid] }),
      client.readContract({ address: addr.oracle, abi: oracleAbi, functionName: "resolver" }),
    ]);
    const st = Number(round.state);
    const [start, end] = seasonWindow(s, a.year);
    const tenth = (v: number) => v / 10;
    return {
      season: `${s.loc.name} · ${s.season.name} ${a.year}`,
      label: isReplay ? "Replay (historical season on the test network)" : "live season",
      season_window_utc: { start: iso(start), end_exclusive: iso(end) },
      oracle_state: ROUND_STATES[st],
      cover_outstanding_tusd: usd(exposure),
      report_opens_utc: iso(from),
      report_deadline_utc: iso(deadline),
      dispute_window_ends_utc: st === 1 ? iso(ends) : null,
      resolver_deadline_utc: st === 2 ? iso(rEnds) : null,
      bond_required_tusd: usd(st === 0 ? bond : round.bond),
      allowed_spread_between_sources_pct: Number(spread) / 100,
      resolver: resolver,
      posted_readings_mm:
        st === 0
          ? null
          : {
              era5: { season_total: tenth(round.era5Total), max_3day: tenth(round.era5Max3) },
              nasa_power: { season_total: tenth(round.powerTotal), max_3day: tenth(round.powerMax3) },
              posted_by: round.proposer,
            },
      final_settlement_mm: st === 3 ? { season_total: Number(round.totalX2) / 20, max_3day: Number(round.max3X2) / 20 } : null,
      explanation: "Settlement is the median (mean of two) of the calibrated ERA5 and NASA POWER readings. A policy does not pay automatically if the two sources fall on opposite sides of its trigger or differ by more than the allowed spread: it becomes contested and the resolver decides.",
    };
  }),
);

// -------------------------------------------------------------------- resource: place catalogue
server.registerResource(
  "locations",
  "dryspell://locations",
  { title: "Locations, seasons and which perils are offered", mimeType: "application/json" },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: JSON.stringify(
          data.locations.map((l: any) => ({ id: l.id, name: l.name, country: l.country, region: l.region, seasons: l.seasons.map((s: any) => ({ id: s.id, name: s.name, perils_offered: s.perils.filter((p: any) => p.offered).map((p: any) => p.peril) })) })),
          null,
          2,
        ),
      },
    ],
  }),
);

await server.connect(new StdioServerTransport());
console.error(`dryspell-mcp ready (read-only) · chain ${deployment.chainId} · PolicyBook ${addr.book}`);
