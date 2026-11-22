# Dryspell audit

Self-audit of the v3 deployment, with the fixes shipped as the v4 deployment, on Arbitrum Sepolia, done as a hostile attacker and a skeptical judge. Findings are listed with what was done about them. Nothing here is a third-party audit.

## Scope

Contracts (`contracts/solidity`, deployed v3), the Stylus crate (not deployed), the data pipeline, the web app, the MCP server, the repository and its git history.

## Summary

| Area | Result |
| --- | --- |
| Secrets and privacy | Clean: 0 secrets in 16 commits, one noreply identity, no `.claude/`, `CLAUDE.md`, `.env`, email, personal path or AI/co-author line |
| Deployment state | Complete: 14/14 seasons, 28/28 calibrations, 16/16 tables, all four contracts wired and owned by one key, no half-wired state |
| Stale deployments | No config, source, doc or build output references a v1 or v2 address |
| Calibration look-ahead | None: factors fit on 1991-2019, the oracle refuses rounds before 2020 |
| Contract logic | No exploitable bug found. The one code-level weakness (engine wiring could be re-pointed by the owner) is fixed in v4; one trust weakness (single resolver) remains |
| Web app | Four defects found and fixed (deep links, phone tables, one display bug, one misleading error) |
| Live buy flow | Passed end to end in a browser with a connected wallet |

## Contracts

Each attack idea, and the evidence it fails or is bounded. Tests are in `contracts/solidity/test`; 86 pass, plus 38 Rust tests and 5 data tests.

| Attack | Outcome | Evidence |
| --- | --- | --- |
| Oracle manipulation: post wrong readings | Bounded, not eliminated. Readings need a bond sized to the cover at stake, a dispute window, and the two sources must be consistent (a 3-day maximum cannot exceed the season total). A colluding reporter and resolver can still win. Documented as the v1 limitation | `WeatherOracle.t.sol` |
| Dispute griefing: dispute every honest report | Costs a bond each time; the loser forfeits it. If the resolver stalls, both sides lose 10%, so stalling is never free | `test_dispute_upheld_*`, `test_resolver_silence_voids_*` |
| Resolver stalls a contested policy | Cannot freeze funds: after the timeout anyone can refund the premium | `Contested.t.sol` |
| Sources disagree, nobody notices | Policies auto-pay only when both sources agree; opposite sides of the trigger or a spread over 50% of the mean makes the policy contested and sends it to the resolver | `Contested.t.sol`, fuzz against a reference model |
| Front-run a forecast storm | Cover must be bought at least 14 days before the season, boundary tested to the second. Price changes between quote and buy are caught by the slippage guard | `test_waiting_period_boundaries`, `test_slippage_guard` |
| Just-in-time deposit to skim a premium | One-hour hold after each deposit; shares are non-transferable and deposits must be for yourself, so a dust deposit cannot reset a victim's lock | `UnderwriterVault.t.sol` |
| Vault donation / inflation attack | Virtual-share offset; the attacker loses about half the donation | `test_donation_attack_*` |
| Vault insolvency / withdrawal race | Assets behind active policies cannot leave; two withdrawers cannot both take the same free liquidity. Fuzzed invariants with random deposits, withdrawals, purchases, disputes, settlements and contested rulings. Removing the withdrawal lock or skipping an exposure release makes the invariants fail (checked by mutation) | `Invariants.t.sol`, `test_two_underwriters_*` |
| Reentrancy | Every state-changing path is guarded. A hook token calls back into the book, vault and oracle mid-transfer and every attempt is blocked; removing a guard makes the test fail (checked by mutation) | `Reentrancy.t.sol` |
| Double payout | A policy settles, is refunded or is ruled exactly once | `test_cannot_settle_before_final_or_twice`, `test_only_the_resolver_decides_*` |
| Rounding drift | Premium rounds up, interpolation rounds up, fee rounds down; premium is never below fitted fair value and never at or above the payout (512-run fuzz); the Solidity engine matches the Rust engine on 6,648 generated vectors including every revert | `testFuzz_premium_*`, `EngineParity.t.sol` |
| Access control | Every admin function is owner-only; book-only functions reject the owner; wiring on the vault and oracle is set once; ownership transfer is two-step | `EngineSol.t.sol`, `UnderwriterVault.t.sol`, `WeatherOracle.t.sol` |
| Replay rounds on a real network | Hard-wired by chain id: allowed on Arbitrum Sepolia, Robinhood testnet and local chains only; refused on Arbitrum One, Ethereum and others, and the owner cannot override it. Every event on a replay carries `replay = true` | `test_replay_is_hard_wired_to_test_networks`, `test_replay_flag_is_in_every_event` |
| Half-wired deployment | None, on v3 (after its resumed broadcast) and on v4 (a single clean broadcast). `mcp/scripts/audit-chain.ts` reads every season window, calibration factor and table point back from the chain and compares it with `data/generated/exceedance.json`: 16/16 tables and 28/28 calibrations identical, 0 mismatches. Ownership, `pendingOwner`, wiring, caps and parameters read back as intended | `pnpm --filter @dryspell/mcp exec tsx scripts/audit-chain.ts` |

### Fixed after the audit (v4)

- **Engine wiring is set-once.** In v3 the owner could re-point the engine's `book` and `vault`, release reserved exposure and let underwriters withdraw collateral behind live policies. In v4 `setBook` and `setVault` revert with `AlreadySet` once wired, in both the Solidity and Stylus engines. Checked live on v4 by simulating the owner's calls: `setBook` and `setVault` both revert with `AlreadySet`. Tests cover the owner and a new owner after a transfer.
- **Utilisation cap bounded at 95%.** With a 100% cap the oracle fee paid at settlement could have taken assets 1-2% below exposure. The engine now refuses anything above 95% (`BadParams`); the deployed value is 80%.

### Weak points that remain

1. **One named resolver, which is also the owner.** It rules on disputes and on contested policies and can choose a wrong result, and the owner can change the resolver at any time. Timeouts stop it freezing funds but not misjudging. Owner and resolver are the same address because a separate resolver would need a third key to manage.
2. **Testnet timings.** A one-hour dispute window and a one-hour vault hold are far shorter than production would use.
3. **Faucet.** TestUSD can be minted repeatedly from many addresses. Intended on a testnet.

### Key rotation

During this audit the testnet owner key was briefly displayed in a developer tool output (a crashing scan script echoed its arguments). The key was never in the repository or its history. It is a throwaway testnet key, but it was rotated anyway on 2026-11-22 (two-step ownership transfer on all four contracts plus the resolver). v4 was then deployed from the new key. The previous address still holds the v3 demo policies and vault shares and has no admin rights on anything.

## Calibration and pricing

- Calibration factors use 1991-2019 only (`CALIBRATION_END_YEAR` in `data/scripts/build.ts`), are produced by one published rule, set once at deployment and write-once on-chain. The oracle refuses any round before 2020, so no season that can be settled feeds its own calibration. An earlier build used all 35 seasons; it was found in review and superseded (v1 and v2).
- Still overlapping, stated in the README: the pricing tables and the source-agreement gate are fitted on all 35 seasons, so a Replay is priced with a fit that includes the replayed season. Forward seasons are not affected.

## Secrets, privacy, attribution

- Scan of the working tree and all history for the deployer key and the Etherscan key: 0 hits. One author and committer identity, the GitHub noreply address, across 16 commits. No `.claude/` or `CLAUDE.md` ever committed (both are in `.gitignore`), no `.env`, no email address, no personal path or name, no AI or co-author line in any file or commit message.
- AI product names were removed from the README and the site; the MCP docs now describe any client generically.

## Web app and live site

Checked in a browser: every page, the wallet flow, wrong-network handling, a full purchase, the empty, loading and error states, links, and the ledger on a phone. Wallet checks used a local test signer on localhost with a locally served copy of the deployed bundle, because the deployed origin cannot reach a localhost signer; the contracts and RPC were the live ones.

| Finding | Status |
| --- | --- |
| Deep links such as `/ledger` returned HTTP 404 on GitHub Pages | **Fixed.** Hash routing (`/dryspell/#/ledger`). Old path URLs reach a small redirect page |
| Skip link and hero button used `#anchors` that collide with hash routing | **Fixed**, now scroll and focus by script |
| Ledger table cramped and half off-screen on a phone | **Fixed.** Rows become labelled cards under 700 px; the same for the Triggers and Backtest tables |
| Resolver-ruled policies showed "settled at 0.0 mm" in the ledger | **Fixed.** Shows "ruled by the resolver" |
| An RPC outage was reported as "the engine will not price this cover" | **Fixed.** Network failures say so, with a Try-again button; real refusals (too late, out of range, round already reported) are explained in plain words |
| Docs out of step with the code: vector count (6,672 vs 6,648), test count (69 vs 84), 2023 calibrated figure (128.2 vs the contract's 128.1), "under construction" status | **Fixed** |

Passed: connect pill with the address, the amber "Switch to Arbitrum Sepolia" pill on the wrong network and back, a purchase (10 tUSD payout, premium 1.10 tUSD, policy 3 on-chain, shown in the ledger), the Ledger and Triggers pages against the settled Garissa 2023 Replay (flood, 122.7 mm, paid, tagged Replay, readings and spreads shown), no console errors and no horizontal overflow on any of the eight routes, the 404 route's empty state, all external links (Arbiscan returns 403 to scripts; source verification of all five contracts was confirmed through the Etherscan API instead).

## MCP server

`pnpm --filter @dryspell/mcp smoke` starts the built server over stdio and calls every tool on the live chain (all read-only; no write-style tool names exist). Registered with a command-line MCP client at local scope it reports "Connected". A model-driven tool call through that client could not be run in this environment.

## What is still weak

Everything under "Weak points that remain", plus: the engine running is the Solidity fallback, not Stylus (activation was paused on Arbitrum Sepolia); there are only about 35 seasons per place; both data sources are gridded products, so basis risk is real; and this is a single-person self-audit.
