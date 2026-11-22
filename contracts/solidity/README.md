# Dryspell contracts (Solidity, Foundry)

```
cd contracts/solidity
forge test            # 69 tests: unit, fuzz, invariants, reentrancy, Rust parity
```

| Contract | Job |
| --- | --- |
| `TestUSD` | **Testnet play money** (6 decimals, no value) with a public faucet: 10,000 per address per hour. |
| `DryspellEngineSol` | **Solidity fallback engine.** Line-for-line port of the Stylus engine with the identical ABI. `engineKind()` returns `"solidity-fallback"`. See "Engine mode" below. |
| `UnderwriterVault` | ERC-4626 pool that backs every policy. Premiums raise the share price; payouts lower it. Collateral behind active policies cannot be withdrawn. |
| `WeatherOracle` | v1 oracle: bonded reporters, dispute window, named resolver, timeouts. |
| `PolicyBook` | Buy cover, waiting period, trigger evaluation, payout, refund. |
| `lib/SeasonCalendar` | UTC season windows (including seasons that cross new year). |

## Engine mode: Stylus or Solidity fallback

Dryspell's pricing and solvency engine is written in Rust for Arbitrum Stylus (`contracts/stylus`). **On 2026-11-21 Stylus activation was paused on Arbitrum Sepolia** (and on the other chains checked): `ArbWasm.activationGas()` returns `2^64 - 1`, and even the untouched `cargo stylus new` template is refused. A Stylus contract cannot be deployed while that holds.

So the repository ships both engines behind one interface (`IDryspellEngine`):

- `DryspellEngineSol` is a **fallback**, not the Stylus build. It has the same function selectors (checked by `node contracts/check-abi-parity.mjs`), the same custom errors, and the same arithmetic including the 128-bit overflow boundaries.
- Equivalence is not just claimed. `contracts/stylus` generates 6,672 quote vectors (successes and every revert reason, across six tables and three parameter sets) with the Rust code, and `test/EngineParity.t.sol` replays them against the Solidity engine. A mutation of the rounding makes that test fail.
- `PolicyBook.engineKind()` reads the engine's own `engineKind()` from the chain, and the web app displays it. **Stylus is never reported as live unless the deployed engine itself answers `"stylus"`.**

At deployment time activation is re-tested against several public RPCs; the Stylus engine is deployed only if one of them accepts it. Otherwise the fallback is deployed and labelled as such.

## Money flow

1. `buy`: the engine prices the cover and reserves `payout` against caps measured on the vault's assets. The premium goes straight into the vault.
2. After the season ends a bonded reporter posts both sources' readings; the oracle calibrates and takes the median.
3. `settle(policyId)` (anyone can call): the engine releases the reserve, the vault pays the holder if the trigger was crossed, and a small oracle fee moves from the vault to the reporter reward pool.
4. If the oracle round is voided (no report in time, or a dispute the resolver ignored), `refund` returns the premium in full.

Trigger rule: drought pays when the season rainfall total is **at or below** the trigger; flood pays when the maximum 3-day rainfall is **at or above** it. Settlement values are in units of 0.05 mm (the sum of the two calibrated readings in 0.1 mm), compared with `trigger_mm * 20`.

## Waiting period (anti front-running)

A policy must be bought at least **14 days before the season starts** (`leadTime`), which is longer than weather forecasts are skilful, so a buyer cannot buy cover on a storm they can already see coming. It cannot be bought more than 400 days ahead. The one exception is a **testnet replay round**: the owner can open a finished historical season (`openReplay`, only on deployments built with `replayEnabled = true`) so a policy can be bought and settled end to end in a demo. Replay rounds are flagged in the `PolicyBought` event and labelled everywhere, and they stop accepting purchases once a report exists.

## Oracle v1 (stated plainly)

1. Any address can post a report by locking a bond. The report carries the raw season total and maximum 3-day rainfall from **both** sources (ERA5 via Open-Meteo, NASA POWER). The contract applies the published calibration factors and computes the median itself, so anyone can verify it from the public APIs.
2. A dispute window follows (anyone can challenge by locking an equal bond).
3. Undisputed: the report finalises, the bond is returned and the reporter earns a small reward.
4. Disputed: a **named resolver** rules. The loser forfeits their bond to the winner. If the resolver does not rule within its timeout, anyone can void the round: premiums are refunded and both sides lose 10% of their bond, so a dispute is never a free way to stall payouts.
5. No report within the reporting window: the round is voided and premiums are refunded.

Bonds scale with the cover at stake (10% of the round's total payout, minimum 100 tUSD).

**Limitations of v1.** The resolver is a single trusted address: it cannot touch anyone's funds except by choosing who wins a disputed bond, but it can choose a wrong result. A colluding reporter and resolver could profit if the payout at stake exceeds what they risk. Calibration factors and season windows are set by the deployer and are write-once. The next step is decentralised resolution: a bonded committee or an optimistic-oracle style escalation game with a final vote.

## Other design notes

- Vault shares are non-transferable and deposits must be for yourself, which closes the "dust deposit resets a victim's lock-up" path. A one-day hold after each deposit blunts just-in-time deposits that skim a premium for risk they never carried. The ERC-4626 virtual-share offset neutralises the donation/inflation attack (tested).
- The vault is fully collateralised: `totalAssets >= engine.totalExposure()` is an invariant, fuzzed with random deposits, withdrawals, purchases, disputes and settlements. Breaking the withdrawal lock or skipping an exposure release makes the invariants fail (checked by mutation).
- `PolicyBook` holds no funds and is the only address that can reserve exposure or pull payouts. Every state-changing path is behind a reentrancy guard; a hook-token test calls back into the book, vault and oracle in the middle of transfers and checks the guard blocks every attempt.
- Admin power is deliberately small: the owner can pause new sales, load pricing tables and set parameters, but cannot move funds, change a policy, or alter calibration or season windows once set.

## Source-disagreement rule (contested policies)

When a round is final, `PolicyBook.settle` compares the two sources' calibrated readings with the policy's trigger. If they fall on **opposite sides of the trigger**, or differ by more than `maxSpreadBps` (50%) of their mean, the policy does **not** pay automatically: it becomes `Contested`, its cover stays reserved, and the named resolver rules with `resolveContested(policyId, pay)`. If the resolver does not rule within `contestTimeout`, anyone can call `refundContested` and the premium goes back to the holder. A contested policy never pays out without the resolver, and never gets stuck. `PolicyContested` and `ContestedRuled` events carry the readings, the spread and the replay flag.

This makes the single trusted resolver more load-bearing in v1: a ruling here is a judgement call, and the limitation is the same as for the oracle (see above).
