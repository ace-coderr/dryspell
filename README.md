# Dryspell

**Parametric weather cover on Arbitrum.** Pick a place, a peril (drought or flood) and a payout. Dryspell prices the cover on-chain from 35 years of real rainfall, locks the premium into an underwriter pool, and pays out automatically when real weather data crosses your trigger. No claim form. No adjuster.

Built for the Arbitrum Open House Dubai Online Buildathon.

- **Live app:** https://ace-coderr.github.io/dryspell/ (Arbitrum Sepolia testnet, TestUSD play money)
- **Security and honesty review:** [AUDIT.md](AUDIT.md)
- **Status:** working testnet prototype. Contracts are deployed and verified, the site reads them live, and a policy has been bought and paid out end to end. It is not an insurance product and nothing here is financial advice.

> **Read this first.** The pricing engine running on-chain is the **Solidity fallback**, not Stylus: Stylus activation is paused on Arbitrum Sepolia. The Rust/Stylus engine is complete and tested, but it is not deployed, and nothing in the app or in this document claims otherwise. The one settled payout on the ledger is a **Replay** (a finished historical season replayed on the test network), not a live payout.

## The problem

Smallholder farmers and pastoral communities in the tropics live on one rainy season. If the rains fail or flood, the year is lost, and conventional crop insurance rarely reaches them: field loss assessment is slow and expensive, claims are disputed, and payouts arrive after the damage is done.

Parametric cover removes the adjuster. The contract pays when an objective measurement crosses a pre-agreed line. Two things have kept this from being open and trustworthy: the price is usually a black box, and the trigger data is usually one source controlled by the seller.

Dryspell puts both in the open: the price is computed on-chain from published historical tables, and the settlement value comes from two independent public datasets whose readings anyone can recompute.

## How it works

1. **Choose a cover.** A location and season (12 places across West Africa, East Africa, South Asia and Southeast Asia), a peril, a trigger in millimetres and a payout.
   - *Drought* pays if the season's rainfall total ends **at or below** the trigger.
   - *Flood* pays if the heaviest rolling 3 days of the season reach **at or above** it.
2. **The price is computed on-chain.** The engine interpolates a fitted probability of paying out (and its standard error) from a table loaded on-chain, then adds a margin and a loading:

   ```
   premium = ceil( payout × ceil( (p + max(1.5 × se, 0.2%)) × 1.25 ) / 1e6 )
   ```

   where `p` is the fitted chance per season of the trigger being crossed and `se` is its bootstrap standard error from 35 seasons. Every division rounds in the pool's favour. Triggers outside the table are refused, and so are quotes above a 70% rate.
3. **Collateral is locked.** The premium goes into the underwriter vault (an ERC-4626 pool of TestUSD). The payout is reserved against caps per region and peril (25% of the pool for drought, 15% for flood, 80% in total). Assets behind active cover cannot be withdrawn.
4. **A waiting period stops front-running.** Cover must be bought at least 14 days before the season starts, longer than weather forecasts are skilful, so nobody can buy on a storm they can already see.
5. **After the season, bonded reporters post the readings.** Anyone can report by locking a bond sized to the cover at stake. A report carries the season total and the maximum 3-day rainfall from **both** sources: ECMWF ERA5 via Open-Meteo and NASA POWER. The contract applies published per-source calibration factors and computes the median itself, so anyone can verify it from the public APIs.
6. **A dispute window follows.** Anyone can challenge with an equal bond. Undisputed reports finalise automatically; the reporter gets the bond back plus a small reward.
7. **Settlement is permissionless.** Anyone can call `settle`. If both sources agree, the contract pays the holder from the vault.
8. **When the sources disagree, the policy is contested.** If the two readings fall on opposite sides of a policy's trigger, or are more than 50% of their mean apart, the policy does not pay automatically: the named resolver rules. If the resolver stays silent past a timeout, anyone can refund the premium. A silent resolver cannot freeze funds.
9. **If nobody reports, the round is voided** and every premium is refundable.

### Contracts

| Contract | Job |
| --- | --- |
| `PolicyBook` | Buy cover, waiting period, trigger evaluation, payout, refund, contested handling. Holds no funds. |
| `UnderwriterVault` | ERC-4626 pool. Premiums raise the share price, payouts lower it. Non-transferable shares, a hold after deposit, a virtual-share offset against donation attacks. |
| `WeatherOracle` | v1 oracle: bonded reporters, dispute window, named resolver, timeouts, per-source calibration, season windows, testnet-only replay rounds. |
| `DryspellEngine` | Pricing and solvency engine. **Two implementations, one ABI:** Rust for Stylus (`contracts/stylus`) and a Solidity fallback (`contracts/solidity`). |
| `TestUSD` | Testnet play money with a public faucet. |

### Data

Daily precipitation for 1991-2025 from two independent sources, for 12 locations, turned into per-season exceedance tables with a Gamma fit for season totals and a Gumbel fit for 3-day maxima, plus a bootstrap standard error. A peril is **offered** only where the two sources' season statistics correlate at 0.40 or more: 16 of the 28 location-season-peril covers qualify, and Kano, Sylhet and Can Tho are shown on the risk map as "not offered" with the reason. Method, calibration rule, terms of use and attribution: [data/README.md](data/README.md).

## Honest limits

- **Stylus activation is paused, so the Solidity fallback is live.** On 2026-11-21 the ArbWasm precompile on Arbitrum Sepolia, Arbitrum One and the Robinhood Chain testnet reported `activationGas = 2^64 - 1`, and even the untouched `cargo stylus new` template was refused. The Solidity engine has the identical ABI, errors and arithmetic and is proven equal to the Rust engine on 6,648 vectors generated by the Rust code. The app and the MCP server read the engine mode from the chain (`solidity-fallback`). Activation is re-checked before every deployment, and the Stylus engine is deployed only if it is accepted.
- **The oracle is v1, with a single owner and resolver.** One named resolver rules on disputes and on contested policies and can choose a wrong result, and on this deployment the **owner and the resolver are the same address** (a separate resolver would need a third key). The owner cannot move vault funds, change a policy, re-point the engine's book or vault (set-once), or alter calibration or season windows once set. It can pause new sales, load pricing tables and parameters, and change the resolver. A production deployment would use a multisig with a timelock, a separate resolver, and decentralised resolution (a bonded committee or an optimistic-oracle escalation game).
- **The two weather sources disagree a lot.** In about 20% of season readings ERA5 and NASA POWER are more than 50% of their mean apart (median spread 24%), and they decide a trigger differently in roughly 8% of seasons at a 3%-odds trigger, 18% at 10% and 25% at 25%. Raw ERA5 and POWER can differ by 2x in a place, so each is calibrated first. Disagreement is not hidden: it makes a policy contested and sends it to the resolver, at the cost of slower, less automatic settlement exactly when the data are ambiguous. The Backtest page shows the contested seasons.
- **The pricing tables are fitted on all 35 seasons.** Calibration factors use 1991-2019 only, so no season that can be settled (2020 onward) feeds its own calibration. The pricing tables and the source-agreement gate are fitted on all 35 seasons, so a Replay is priced with a fit that includes the replayed season. Forward seasons (2027 and later) do not have this overlap.
- **Basis risk.** Both datasets are gridded, tens of kilometres wide. The cover pays on the data, not on any one farm: on a patchy storm the field can fail while the data say normal, or the reverse.
- **Thin history.** About 35 seasons per place, so tail odds carry real sampling error. The price loads for it with the uncertainty margin.
- **The settled payout is a Replay.** The Garissa 2023 flood policy was bought for a past season on a test network, with the owner opening the round and a trigger chosen knowing the outcome. Replays are hard-wired to test networks by chain id, are tagged "Replay" in the app, and carry `replay = true` in every event. The live forward-season policy (Jodhpur monsoon 2027) cannot settle until that season ends.
- **Testnet settings are short.** A one-hour dispute window and vault hold, far shorter than a production deployment should use.
- **TestUSD is play money** with a public faucet. There is no real value anywhere.

## Live deployment (v4, Arbitrum Sepolia)

| Contract | Address |
| --- | --- |
| PolicyBook | [0xB7Da8Ca395b4e63c6048C24De2bc8805Cd0CeED6](https://sepolia.arbiscan.io/address/0xB7Da8Ca395b4e63c6048C24De2bc8805Cd0CeED6#code) |
| UnderwriterVault | [0x2613a20E5E689557a346f051eb29f61Dc3612B9d](https://sepolia.arbiscan.io/address/0x2613a20E5E689557a346f051eb29f61Dc3612B9d#code) |
| WeatherOracle | [0xd1707dE44eA6f366aB59009B5B8F74c8aE8D9989](https://sepolia.arbiscan.io/address/0xd1707dE44eA6f366aB59009B5B8F74c8aE8D9989#code) |
| Engine (**Solidity fallback**) | [0x811820dDE76775a2b0f54757ea2feD328A149331](https://sepolia.arbiscan.io/address/0x811820dDE76775a2b0f54757ea2feD328A149331#code) |
| TestUSD | [0x08ae25c4240c5E7e999b46904034D3FdF37cB879](https://sepolia.arbiscan.io/address/0x08ae25c4240c5E7e999b46904034D3FdF37cB879#code) |

All five are verified on Arbiscan; the same addresses are in [contracts/deployments/arbitrum-sepolia.json](contracts/deployments/arbitrum-sepolia.json), which the web app and the MCP server read.

Version history: v1 had no disagreement rule, v2 added it but calibrated on all seasons, v3 fixed calibration but left the engine wiring re-pointable, v4 (live) makes the wiring set-once and bounds utilisation at 95%. v1 to v3 are superseded, with reasons in `contracts/deployments/*-superseded.json`.

Demo state on v4: one forward-season policy (Jodhpur monsoon 2027, drought, 500 tUSD) and one **Replay** (Garissa short rains 2023, flood, 500 tUSD, both sources above the 103 mm trigger, paid automatically at 122.7 mm).

## The app

A static React site (hash-routed, so every page survives a refresh on GitHub Pages) that reads and writes the chain with viem and wagmi.

| Page | What it does |
| --- | --- |
| Buy cover | Live quote from the deployed engine with a price breakdown, the rainfall ribbon drawing into your trigger, and the full buy flow (faucet, approve, buy) |
| Vault | Deposit and withdraw, utilisation, share value, exposure against every region and peril cap |
| Risk map | 35 seasons of real rainfall per place, odds at each trigger, and why the premium is what it is |
| Triggers | Live readings from both sources, oracle state, countdowns, report, dispute and finalise actions, contested policies |
| Ledger | Every policy, trigger and payout with Arbiscan links, Replay rows tagged |
| Backtest | Real history replayed through the pricing rules, hits and misses and contested seasons, labelled as a backtest |
| Agents | How to connect the MCP server, with the live chain status it serves |

There is also a read-only [MCP server](mcp/README.md) (quote cover, list policies, read vault state and trigger status) so an AI agent can read the book.

## Setup

Requirements: Node 20+, pnpm 9, and for the contracts Foundry. The Stylus tooling does not compile on native Windows (`cargo-stylus` uses Unix-only APIs); use WSL or Linux with Rust and `cargo-stylus`.

```
git clone https://github.com/ace-coderr/dryspell.git
cd dryspell
git submodule update --init --recursive     # OpenZeppelin and forge-std
pnpm install
```

**Run the site** (reads the deployed v4 contracts, no key needed):

```
pnpm web:dev           # http://localhost:5173/dryspell/
pnpm web:build         # production build into web/dist
```

**Rebuild the data** (fetches real daily rainfall from Open-Meteo and NASA POWER, free, no key):

```
pnpm --filter @dryspell/data run pull      # download both sources
pnpm --filter @dryspell/data run build     # fit tables -> data/generated/exceedance.json
pnpm --filter @dryspell/data run disagree  # source-disagreement statistics
pnpm --filter @dryspell/data test
```

**Test the contracts:**

```
cd contracts/solidity && forge test                       # 86 tests: unit, fuzz, invariants, reentrancy, contested path, Rust parity
cd contracts/stylus   && cargo test --lib                  # 38 tests (in WSL or Linux)
node contracts/check-abi-parity.mjs                        # Solidity and Stylus engines expose the same selectors
pnpm --filter @dryspell/mcp exec tsx scripts/audit-chain.ts  # read the live chain back and compare it with the JSON
```

**Deploy to Arbitrum Sepolia** (use a throwaway key funded from a public faucet; never reuse a mainnet key):

```
cp .env.example .env     # then fill in DEPLOYER_PRIVATE_KEY (and ETHERSCAN_API_KEY to verify)
cd contracts/solidity
forge script script/Deploy.s.sol --rpc-url $ARBITRUM_SEPOLIA_RPC                    # dry run, prints the gas estimate
forge script script/Deploy.s.sol --rpc-url $ARBITRUM_SEPOLIA_RPC --broadcast --slow  # real deployment
```

The script deploys everything and loads the real tables, season windows, calibration factors and caps from `data/generated/exceedance.json`; the dry run prints the gas estimate before you spend anything. `script/Resume.s.sol` finishes an interrupted run by sending only what is missing. To use the Stylus engine instead, deploy it with `cargo stylus` first (only possible once activation is open) and pass its address as `ENGINE_ADDRESS`.

**MCP server:** `pnpm --filter @dryspell/mcp build`, then add `node /absolute/path/to/mcp/dist/index.js` to your MCP client; `pnpm --filter @dryspell/mcp smoke` checks every tool against the live chain. Details in [mcp/README.md](mcp/README.md).

The site deploys to GitHub Pages from `main` with the workflow in `.github/workflows/pages.yml`.

## Judging criteria

**Smart contract quality.** Reentrancy guards on every state-changing path; checks-effects-interactions; set-once wiring; two-step ownership; the owner cannot touch funds. 86 Solidity tests including fuzzing and stateful invariants (the vault always covers exposure; exposure equals the payouts of active and contested policies; the book never holds tokens), and the invariants and reentrancy tests are mutation-checked: removing the withdrawal lock, skipping an exposure release or removing a guard makes them fail. The Solidity engine is proven equal to the Rust engine on 6,648 generated vectors including every revert reason. A deployment script test checks all 16 tables and 14 seasons, and an audit script reads the live chain back and compares it with the source data (16/16 tables, 28/28 calibrations). A written self-audit with attack scenarios, evidence and unresolved weaknesses is in [AUDIT.md](AUDIT.md).

**Real problem solved.** Rain-fed smallholder agriculture has a real insurance gap, and the barrier is trust and cost of assessment, which an objective, open settlement rule attacks directly. What is demonstrated is the mechanism, honestly scoped: real data, real on-chain pricing and a real automatic payout on a test network. It does not prove demand, regulatory fit or that farmers would use it, and basis risk is a genuine limit.

**Product-market fit.** The target is weather-index cover sold to farming cooperatives, NGOs and relief programmes in the places where the data are most useful. The product decisions follow from that: cover only where two independent datasets agree enough to trust, a waiting period against adverse selection, a visible price breakdown, and a Backtest page that shows the misses instead of hiding them. No real users yet.

**Innovation.** Pricing computed on-chain from published exceedance tables with an uncertainty margin, so the premium rises where the evidence is thin; a two-source oracle with published calibration where disagreement is detected on-chain and routed to a resolver instead of being averaged away; a rule-based dispute and timeout design in which no actor can freeze funds; and a dual implementation (Rust and Solidity) locked together by generated test vectors.

## Why Arbitrum

- **Cost makes on-chain pricing and data practical.** The whole deployment, including 14 season windows, 28 calibration factors and 16 pricing tables loaded on-chain, took a few dozen transactions paid from a faucet-sized balance. A purchase used roughly 223,000 to 306,000 gas and a settlement about 178,000, at a base fee near 0.02 gwei. Loading and reading this much data on Ethereum mainnet would make small-payout cover uneconomic.
- **Fast blocks and low fees suit the oracle design.** Bonded reports, short dispute windows, countdowns and permissionless settlement only work if sending a transaction is cheap enough that anyone will do it.
- **Full EVM compatibility.** Foundry, OpenZeppelin, viem and wagmi worked unchanged; the same contracts are portable to other Arbitrum chains, including the Robinhood Chain testnet (the Stylus availability there was checked and was also paused, not assumed).
- **Stylus is why the engine is written in Rust, but it is not load-bearing today.** Table interpolation and 128-bit fixed-point arithmetic are the kind of compute where WASM is much cheaper than the EVM, which is what would let the full pricing path stay on-chain as tables and regions grow. That Rust engine is built and tested to the same ABI and parity-locked to the fallback, and `cargo stylus check` builds it to 30 KB of WASM, but chain-side activation is paused, so the Solidity fallback does the work now. No gas saving from Stylus has been measured here, and none is claimed.

## Repository layout

| Path | Contents |
| --- | --- |
| `contracts/stylus` | Rust (Stylus) pricing and solvency engine, tests, exported ABI |
| `contracts/solidity` | Solidity (Foundry) contracts, tests, deployment and resume scripts |
| `contracts/deployments` | Live deployment record and superseded records with reasons |
| `web` | React + TypeScript + Vite front end |
| `mcp` | Read-only MCP server and chain audit script |
| `data` | Weather-data scripts and generated exceedance tables ([data/README.md](data/README.md)) |

## Attribution and terms

Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0; ERA5 © Copernicus Climate Change Service) and [NASA POWER](https://power.larc.nasa.gov/). Open-Meteo's free tier is for non-commercial use; a commercial product would need a paid plan or another licensed source. Full terms are in [data/README.md](data/README.md).

Released under the MIT licence.
