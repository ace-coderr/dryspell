# Dryspell

Parametric weather cover on Arbitrum. A buyer picks a location, a peril (drought or flood) and a payout. Dryspell prices the cover on-chain, locks the premium into an underwriter pool, and pays out automatically when real weather data crosses the trigger. No claims form, no adjuster.

Built for the Arbitrum Open House Dubai Online Buildathon.

Status: under construction. Full documentation lands with the first deployment.

## Layout

| Path | Contents |
| --- | --- |
| `contracts/stylus` | Rust (Stylus) pricing and solvency engine |
| `contracts/solidity` | Solidity (Foundry) policy book, vault, test token, oracle |
| `web` | React + TypeScript + Vite front end (static, GitHub Pages) |
| `mcp` | Model Context Protocol server (runs locally) |
| `data` | Weather-data scripts and generated exceedance tables |

## Data sources

Dryspell is priced from real daily rainfall, 1991-2025, for 12 locations across West Africa, East Africa, South Asia and Southeast Asia, from two independent sources: Open-Meteo (ECMWF ERA5, CC BY 4.0, free non-commercial tier) and NASA POWER (cite service and access date). Terms, attribution, method and limits are in [data/README.md](data/README.md).
