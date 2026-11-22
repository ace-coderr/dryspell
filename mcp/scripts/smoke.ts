// End-to-end check: starts the built server over stdio like an MCP client would and calls every tool on the live chain.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import assert from "node:assert/strict";

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const call = async (name: string, args: Record<string, unknown>) => {
  const r: any = await client.callTool({ name, arguments: args });
  const t = r.content[0].text as string;
  return { isError: !!r.isError, text: t, json: r.isError ? null : JSON.parse(t) };
};

const tools = (await client.listTools()).tools;
const names = tools.map((t) => t.name).sort();
console.log("tools:", names.join(", "));
assert.deepEqual(names, ["list_policies", "quote_cover", "read_trigger_status", "read_vault"]);
assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true), "every tool is read-only");
assert.ok(!names.some((n) => /buy|send|write|sign|settle|deposit|withdraw/.test(n)), "no write-style tools");

const q = await call("quote_cover", { location: "jodhpur", peril: "drought", trigger_mm: 142, payout_tusd: 500, year: 2027 });
console.log("quote:", q.json.premium_tusd, "tUSD,", q.json.label, "| engine", q.json.engine);
assert.ok(!q.isError && Math.abs(q.json.premium_tusd - 43.987) < 0.01);
assert.equal(q.json.label, "live forward season");

// the settled Replay round can no longer be bought, and the error says why in plain words
const r = await call("quote_cover", { location: "garissa", season: "short", peril: "flood", trigger_mm: 103, payout_tusd: 500, year: 2023 });
assert.ok(r.isError && /already has a report/.test(r.text));
console.log("settled round:", r.text);

const no = await call("quote_cover", { location: "kano", peril: "drought", trigger_mm: 400, payout_tusd: 100, year: 2027 });
assert.equal(no.json.offered, false);
console.log("not offered:", no.json.reason);

const bad = await call("quote_cover", { location: "atlantis", peril: "flood", trigger_mm: 10, payout_tusd: 10 });
assert.ok(bad.isError, "unknown location is an error, not a crash");
const out = await call("quote_cover", { location: "jodhpur", peril: "drought", trigger_mm: 5, payout_tusd: 500, year: 2027 });
assert.ok(out.isError, "a trigger outside the priced range is refused by the engine");
console.log("out of range:", out.text);

const p = await call("list_policies", { limit: 10 });
console.log("policies:", p.json.total_policies, p.json.policies.map((x: any) => `#${x.id} ${x.cover} ${x.year} ${x.status} ${x.label}`).join(" | "));
assert.ok(p.json.total_policies >= 2);
const replayPaid = p.json.policies.find((x: any) => x.replay && x.status === "paid_out");
assert.ok(replayPaid, "the settled Replay policy is listed and labelled");

const v = await call("read_vault", {});
console.log("vault:", v.json.engine_mode, "assets", v.json.total_assets_tusd, "util%", v.json.utilisation_pct, "share", v.json.share_value_tusd.toFixed(4));
assert.equal(v.json.engine_mode, "solidity-fallback");
assert.equal(v.json.exposure_by_region_and_peril.length, 8);

const t = await call("read_trigger_status", { location: "garissa", season: "short", year: 2023 });
console.log("trigger:", t.json.oracle_state, t.json.label, "final", JSON.stringify(t.json.final_settlement_mm));
assert.equal(t.json.oracle_state, "final");
assert.match(t.json.label, /^Replay/);

const res = await client.readResource({ uri: "dryspell://locations" });
assert.ok(JSON.parse((res.contents[0] as any).text).length === 12);
console.log("resource ok: 12 locations");

await client.close();
console.log("\nALL MCP SMOKE CHECKS PASSED");
