# Dryspell engine (Stylus, Rust)

Pricing and solvency engine for Dryspell cover. Written in Rust for Arbitrum Stylus.

| Module | Job |
| --- | --- |
| `src/pricing.rs` | Fixed-point pricing. Interpolates the fitted payout probability and its standard error from an exceedance table, adds a risk margin and a loading, rounds up in the pool's favour, and refuses triggers outside the table or rates above a cap. |
| `src/solvency.rs` | Exposure caps per (region, peril) and in total, against the vault's capital. Rejects any policy that would breach a cap. |
| `src/lib.rs` | The contract: storage, owner-only table and parameter admin (two-step ownership, constructor-initialised), book-only `reserve` / `release`, and a vault `totalAssets()` read so the caller can never lie about capital. |
| `abi/IDryspellEngine.sol` | Solidity interface exported with `cargo stylus export-abi`. |

Premium: `ceil(payout * ceil((p + max(ceil(k * se), floor)) * (1 + loading)) / 1e6)`, where `p` and `se` come from `data/generated/exceedance.json`.

## Build and test

The Stylus tooling does not compile on native Windows (`cargo-stylus` uses Unix-only APIs), so run it in WSL or Linux:

```
cd contracts/stylus
cargo test --lib                 # 38 tests, including every real offered table, set-once wiring and the Solidity parity vectors
cargo stylus check --endpoint https://sepolia-rollup.arbitrum.io/rpc
```

Dependencies are pinned exactly (`stylus-sdk =0.10.10`, `alloy-* =1.7.3`) and `Cargo.lock` is committed.

## Status of on-chain activation

`cargo stylus check` builds the WASM (30 KB, 2 fragments) but the chain-side activation simulation is refused: on 2026-11-21 the ArbWasm precompile on Arbitrum Sepolia, Arbitrum One and the Robinhood Chain testnet all report `activationGas = 2^64 - 1`, the owner-controlled pause value, and the untouched `cargo stylus new` Counter template is refused the same way. See the repository README for how this affects deployment.

Because of this, a Solidity fallback engine with the identical ABI lives in `contracts/solidity` and the Rust code generates the test vectors that pin the two together (`DRYSPELL_WRITE_VECTORS=1 cargo test --lib parity_vectors`). `node contracts/check-abi-parity.mjs` checks that both expose the same selectors. Activation is re-tested before deployment; the Stylus engine is deployed only if a public RPC accepts it.
