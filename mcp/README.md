# Dryspell MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI agent quote cover and read the pool, policies and oracle status of Dryspell straight from the contracts on Arbitrum Sepolia.

- **Read-only.** There is no wallet, key or signer anywhere in this server, and no tool that buys, settles, deposits, withdraws or reports. Anything that moves tUSD stays a human-signed action in the web app.
- **Runs locally** over stdio. It is not hosted: the site is on GitHub Pages, which only serves static files.
- Reads the live chain (default RPC `https://sepolia-rollup.arbitrum.io/rpc`, override with `DRYSPELL_RPC`). Contract addresses and pricing tables come from `contracts/deployments/arbitrum-sepolia.json` and `data/generated/exceedance.json` in this repository, so run it from a checkout.

## Setup

Requires Node 20+ and pnpm.

```
pnpm install
pnpm --filter @dryspell/mcp build
```

Add it to your MCP client with the **absolute** path to the built file.

Claude Code:

```
claude mcp add dryspell -- node /absolute/path/to/dryspell/mcp/dist/index.js
```

Claude Desktop, Cursor and other clients (JSON config):

```json
{
  "mcpServers": {
    "dryspell": {
      "command": "node",
      "args": ["/absolute/path/to/dryspell/mcp/dist/index.js"]
    }
  }
}
```

Check it works against the live chain:

```
pnpm --filter @dryspell/mcp smoke
```

The smoke test starts the built server like a client would, lists the tools, calls each one on Arbitrum Sepolia, and asserts the results: every tool is marked read-only, a Replay is labelled as one, and bad input comes back as a clear error.

## Tools

| Tool | What it does |
| --- | --- |
| `quote_cover` | Price a cover exactly as the on-chain engine would: `location`, optional `season`, `peril` (drought or flood), `trigger_mm`, `payout_tusd`, optional `year`. Returns premium, fitted odds, uncertainty and whether the season is a Replay. Explains refusals in plain words (outside the priced range, too late to buy, not offered, round already reported). |
| `list_policies` | Policies from the PolicyBook with status (`active`, `paid_out`, `expired_no_payout`, `refunded`, `contested`), trigger, payout, premium and a Replay flag. Optional `holder`, `status`, `limit`. |
| `read_vault` | Pool assets, locked collateral, utilisation, share value, exposure against each region and peril cap, and the **engine mode** (`stylus` or `solidity-fallback`) read from the chain. |
| `read_trigger_status` | Oracle state of a covered season (`none`, `proposed`, `disputed`, `final`, `void`), dispute-window times, both sources' posted readings, final settlement values, allowed spread, outstanding cover. |

It also serves a resource, `dryspell://locations`, listing the 12 locations, their seasons and which perils are offered.

Example prompts: "Quote 500 tUSD of drought cover for Jodhpur's 2027 monsoon at 142 mm", "How much of the vault is in use, and is the engine running on Stylus?", "Where does the Garissa 2023 round stand, and was it a replay?"

## Honest notes

- **Engine mode is reported, never assumed.** `read_vault` and `quote_cover` return what the deployed engine says about itself. While Stylus activation is paused on Arbitrum Sepolia that is `solidity-fallback`.
- **Replays are labelled** in every tool that can return one: a Replay is a finished historical season replayed on the test network so a payout can be shown end to end.
- **Testnet only.** tUSD is play money. Quotes are not financial advice and not an offer of insurance.
- Weather data: [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0), ERA5 from the Copernicus Climate Change Service, and NASA POWER.
