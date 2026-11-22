//! Dryspell engine (Arbitrum Stylus, Rust).
//!
//! Two jobs, both done on-chain so nobody has to trust an off-chain price:
//!
//! 1. **Pricing** - `quote()` turns a trigger level and payout into a premium from
//!    an exceedance table (fitted payout probability + standard error per trigger
//!    level, derived from 35 years of real rainfall), a risk margin on the
//!    standard error, and a loading. Pure integer math, rounded in the pool's favour.
//! 2. **Solvency** - `reserve()` / `release()` track exposure per (region, peril)
//!    and in total, and reject any policy that would push exposure past the caps.
//!    Capital is read from the underwriter vault by this contract, never taken
//!    from the caller.
//!
//! Only the configured PolicyBook may reserve or release exposure. The owner
//! (a two-step transferable role) loads tables and sets parameters.
//!
//! Why Stylus: the table interpolation, 128-bit fixed-point arithmetic and
//! bounds checks run in WASM, which is far cheaper per operation than the EVM, so
//! the full pricing path stays affordable on-chain.

#![cfg_attr(not(any(test, feature = "export-abi")), no_main)]
extern crate alloc;

use alloc::{string::String, vec::Vec};
use stylus_sdk::{
    alloy_primitives::{Address, U256},
    alloy_sol_types::sol,
    prelude::*,
};

pub mod pricing;
pub mod solvency;

use pricing::{Params, Peril, Point, PriceError, TableError};
use solvency::SolvencyError;

sol! {
    error NotOwner();
    error NotPendingOwner();
    error NotBook();
    error ZeroAddress();
    error BadParams();
    /// code: 1 too few points, 2 bad peril, 3 levels not monotone, 4 probability not monotone,
    /// 5 probability too large, 6 zero probability, 7 too many points, 8 length mismatch,
    /// 9 region/peril changed on reload
    error BadTable(uint8 code);
    error UnknownTable();
    error TableDisabled();
    error OutOfRange();
    error RateTooHigh();
    error ZeroPayout();
    error AmountTooLarge();
    /// which: 1 region/peril cap, 2 total utilization cap
    error CapBreached(uint8 which);
    error NoCapital();
    error NoCap();
    error ReleaseTooLarge();
    error VaultCallFailed();
    error MathOverflow();
    /// the book and vault wiring can be set exactly once
    error AlreadySet();

    event TableLoaded(uint256 indexed tableId, uint8 region, uint8 peril, uint256 points);
    event TableEnabled(uint256 indexed tableId, bool enabled);
    event ParamsSet(uint256 marginKBps, uint256 floorPpm, uint256 loadingBps, uint256 maxRatePpm, uint256 maxUtilBps);
    event CapSet(uint8 region, uint8 peril, uint256 capBps);
    event BookSet(address book);
    event VaultSet(address vault);
    event Reserved(uint256 indexed tableId, uint256 payout, uint256 regionPerilExposure, uint256 totalExposure);
    event Released(uint256 indexed tableId, uint256 payout, uint256 regionPerilExposure, uint256 totalExposure);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
}

#[derive(SolidityError)]
pub enum EngineError {
    NotOwner(NotOwner),
    NotPendingOwner(NotPendingOwner),
    NotBook(NotBook),
    ZeroAddress(ZeroAddress),
    BadParams(BadParams),
    BadTable(BadTable),
    UnknownTable(UnknownTable),
    TableDisabled(TableDisabled),
    OutOfRange(OutOfRange),
    RateTooHigh(RateTooHigh),
    ZeroPayout(ZeroPayout),
    AmountTooLarge(AmountTooLarge),
    CapBreached(CapBreached),
    NoCapital(NoCapital),
    NoCap(NoCap),
    ReleaseTooLarge(ReleaseTooLarge),
    VaultCallFailed(VaultCallFailed),
    MathOverflow(MathOverflow),
    AlreadySet(AlreadySet),
}

// The sol! error types do not implement Debug; tests need it for `unwrap`.
#[cfg(test)]
impl core::fmt::Debug for EngineError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(f, "EngineError(revert)")
    }
}

fn bad_table(code: u8) -> EngineError {
    EngineError::BadTable(BadTable { code })
}

impl From<PriceError> for EngineError {
    fn from(e: PriceError) -> Self {
        match e {
            PriceError::ZeroPayout => EngineError::ZeroPayout(ZeroPayout {}),
            PriceError::OutOfRange | PriceError::EmptyTable => EngineError::OutOfRange(OutOfRange {}),
            PriceError::RateTooHigh => EngineError::RateTooHigh(RateTooHigh {}),
            PriceError::Overflow => EngineError::MathOverflow(MathOverflow {}),
        }
    }
}

impl From<TableError> for EngineError {
    fn from(e: TableError) -> Self {
        bad_table(match e {
            TableError::TooFewPoints => 1,
            TableError::BadPeril => 2,
            TableError::LevelsNotMonotone => 3,
            TableError::ProbabilityNotMonotone => 4,
            TableError::ProbabilityTooLarge => 5,
            TableError::ZeroProbability => 6,
            TableError::TooManyPoints => 7,
        })
    }
}

impl From<SolvencyError> for EngineError {
    fn from(e: SolvencyError) -> Self {
        match e {
            SolvencyError::ZeroPayout => EngineError::ZeroPayout(ZeroPayout {}),
            SolvencyError::NoCapital => EngineError::NoCapital(NoCapital {}),
            SolvencyError::NoCap => EngineError::NoCap(NoCap {}),
            SolvencyError::RegionPerilCapBreached => EngineError::CapBreached(CapBreached { which: 1 }),
            SolvencyError::TotalCapBreached => EngineError::CapBreached(CapBreached { which: 2 }),
            SolvencyError::Overflow => EngineError::MathOverflow(MathOverflow {}),
            SolvencyError::ReleaseTooLarge => EngineError::ReleaseTooLarge(ReleaseTooLarge {}),
        }
    }
}

sol_interface! {
    interface IVault {
        function totalAssets() external view returns (uint256);
    }
}

sol_storage! {
    #[entrypoint]
    pub struct DryspellEngine {
        address owner;
        address pending_owner;
        /// The only address allowed to reserve and release exposure.
        address book;
        /// Underwriter vault; its totalAssets() is the capital base for caps.
        address vault;

        uint256 margin_k_bps;
        uint256 floor_ppm;
        uint256 loading_bps;
        uint256 max_rate_ppm;
        uint256 max_util_bps;

        uint256 total_exposure;
        /// key = (region << 8) | peril
        mapping(uint256 => uint256) exposure;
        mapping(uint256 => uint256) cap_bps;

        /// bit0 exists, bit1 enabled, bits 8..16 region, bits 16..24 peril
        mapping(uint256 => uint256) table_meta;
        /// each point packed as level | p_ppm << 32 | se_ppm << 64
        mapping(uint256 => uint256[]) table_points;
    }
}

const META_EXISTS: u64 = 1;
const META_ENABLED: u64 = 2;

fn pack_meta(enabled: bool, region: u8, peril: u8) -> U256 {
    let mut v = META_EXISTS;
    if enabled {
        v |= META_ENABLED;
    }
    v |= (region as u64) << 8;
    v |= (peril as u64) << 16;
    U256::from(v)
}

struct Meta {
    exists: bool,
    enabled: bool,
    region: u8,
    peril: u8,
}

fn unpack_meta(m: U256) -> Meta {
    let v: u64 = m.to::<u64>();
    Meta {
        exists: v & META_EXISTS != 0,
        enabled: v & META_ENABLED != 0,
        region: ((v >> 8) & 0xff) as u8,
        peril: ((v >> 16) & 0xff) as u8,
    }
}

fn pack_point(p: &Point) -> U256 {
    U256::from(p.level) | (U256::from(p.p_ppm) << 32) | (U256::from(p.se_ppm) << 64)
}

fn unpack_point(v: U256) -> Point {
    let mask = U256::from(u32::MAX);
    Point {
        level: (v & mask).to::<u32>(),
        p_ppm: ((v >> 32usize) & mask).to::<u32>(),
        se_ppm: ((v >> 64usize) & mask).to::<u32>(),
    }
}

fn cap_key(region: u8, peril: u8) -> U256 {
    U256::from(((region as u64) << 8) | peril as u64)
}

fn to_u128(x: U256) -> Result<u128, EngineError> {
    u128::try_from(x).map_err(|_| EngineError::AmountTooLarge(AmountTooLarge {}))
}

fn to_u32(x: U256) -> Result<u32, EngineError> {
    u32::try_from(x).map_err(|_| EngineError::OutOfRange(OutOfRange {}))
}

impl DryspellEngine {
    fn only_owner(&self) -> Result<(), EngineError> {
        if self.vm().msg_sender() != self.owner.get() {
            return Err(EngineError::NotOwner(NotOwner {}));
        }
        Ok(())
    }

    fn only_book(&self) -> Result<(), EngineError> {
        let book = self.book.get();
        if book == Address::ZERO || self.vm().msg_sender() != book {
            return Err(EngineError::NotBook(NotBook {}));
        }
        Ok(())
    }

    fn params_now(&self) -> Params {
        Params {
            margin_k_bps: self.margin_k_bps.get().to::<u32>(),
            floor_ppm: self.floor_ppm.get().to::<u32>(),
            loading_bps: self.loading_bps.get().to::<u32>(),
            max_rate_ppm: self.max_rate_ppm.get().to::<u32>(),
        }
    }

    fn table(&self, id: U256) -> Result<(Meta, Vec<Point>), EngineError> {
        let meta = unpack_meta(self.table_meta.get(id));
        if !meta.exists {
            return Err(EngineError::UnknownTable(UnknownTable {}));
        }
        let v = self.table_points.getter(id);
        let mut pts = Vec::with_capacity(v.len());
        for i in 0..v.len() {
            pts.push(unpack_point(v.get(i).unwrap_or(U256::ZERO)));
        }
        Ok((meta, pts))
    }

    fn capital(&self) -> Result<u128, EngineError> {
        let vault = self.vault.get();
        if vault == Address::ZERO {
            return Err(EngineError::NoCapital(NoCapital {}));
        }
        let assets = IVault::new(vault)
            .total_assets(self.vm(), Call::new())
            .map_err(|_| EngineError::VaultCallFailed(VaultCallFailed {}))?;
        to_u128(assets)
    }

    fn set_params_checked(&mut self, k: U256, floor: U256, loading: U256, max_rate: U256, max_util: U256) -> Result<(), EngineError> {
        let conv = |x: U256| u32::try_from(x).map_err(|_| EngineError::BadParams(BadParams {}));
        let p = Params {
            margin_k_bps: conv(k)?,
            floor_ppm: conv(floor)?,
            loading_bps: conv(loading)?,
            max_rate_ppm: conv(max_rate)?,
        };
        let util = conv(max_util)?;
        // utilisation is capped at 95% so the oracle fee paid at settlement can never push assets below exposure
        if !p.is_valid() || util == 0 || util > 9_500 {
            return Err(EngineError::BadParams(BadParams {}));
        }
        self.margin_k_bps.set(k);
        self.floor_ppm.set(floor);
        self.loading_bps.set(loading);
        self.max_rate_ppm.set(max_rate);
        self.max_util_bps.set(max_util);
        self.vm().log(ParamsSet {
            marginKBps: k,
            floorPpm: floor,
            loadingBps: loading,
            maxRatePpm: max_rate,
            maxUtilBps: max_util,
        });
        Ok(())
    }
}

#[public]
impl DryspellEngine {
    /// Runs atomically with deployment (Stylus constructor), so nobody can front-run initialization.
    #[constructor]
    pub fn constructor(&mut self, owner: Address) -> Result<(), EngineError> {
        if owner == Address::ZERO {
            return Err(EngineError::ZeroAddress(ZeroAddress {}));
        }
        self.owner.set(owner);
        // Conservative launch defaults: 1.5x standard error, 0.2% floor, +25% loading,
        // refuse rates above 70% of payout, never exceed 80% total utilization.
        self.set_params_checked(
            U256::from(15_000u32),
            U256::from(2_000u32),
            U256::from(2_500u32),
            U256::from(700_000u32),
            U256::from(8_000u32),
        )?;
        self.vm().log(OwnershipTransferred {
            previousOwner: Address::ZERO,
            newOwner: owner,
        });
        Ok(())
    }

    // ----------------------------------------------------------------- views

    /// Identifies the implementation. The Solidity fallback returns "solidity-fallback".
    pub fn engine_kind(&self) -> String {
        String::from("stylus")
    }

    pub fn owner(&self) -> Address {
        self.owner.get()
    }

    pub fn pending_owner(&self) -> Address {
        self.pending_owner.get()
    }

    pub fn book(&self) -> Address {
        self.book.get()
    }

    pub fn vault(&self) -> Address {
        self.vault.get()
    }

    /// (marginKBps, floorPpm, loadingBps, maxRatePpm, maxUtilBps)
    pub fn params(&self) -> (U256, U256, U256, U256, U256) {
        (
            self.margin_k_bps.get(),
            self.floor_ppm.get(),
            self.loading_bps.get(),
            self.max_rate_ppm.get(),
            self.max_util_bps.get(),
        )
    }

    pub fn total_exposure(&self) -> U256 {
        self.total_exposure.get()
    }

    pub fn exposure_of(&self, region: u8, peril: u8) -> U256 {
        self.exposure.get(cap_key(region, peril))
    }

    pub fn cap_bps_of(&self, region: u8, peril: u8) -> U256 {
        self.cap_bps.get(cap_key(region, peril))
    }

    /// (exists, enabled, region, peril)
    pub fn table_info(&self, table_id: U256) -> (bool, bool, u8, u8) {
        let m = unpack_meta(self.table_meta.get(table_id));
        (m.exists, m.enabled, m.region, m.peril)
    }

    /// (levels, pPpm, sePpm), ordered by increasing probability of payout.
    pub fn table_points(&self, table_id: U256) -> Result<(Vec<u32>, Vec<u32>, Vec<u32>), EngineError> {
        let (_, pts) = self.table(table_id)?;
        Ok((
            pts.iter().map(|p| p.level).collect(),
            pts.iter().map(|p| p.p_ppm).collect(),
            pts.iter().map(|p| p.se_ppm).collect(),
        ))
    }

    /// Price a cover. Reverts if the table is unknown or disabled, the trigger is outside
    /// the table, or the all-in rate exceeds the configured cap.
    /// Returns (premium, pPpm, sePpm, ratePpm). pPpm/sePpm are interpolated and rounded up.
    pub fn quote(&self, table_id: U256, trigger_mm: U256, payout: U256) -> Result<(U256, U256, U256, U256), EngineError> {
        let (meta, pts) = self.table(table_id)?;
        if !meta.enabled {
            return Err(EngineError::TableDisabled(TableDisabled {}));
        }
        let peril = Peril::from_u8(meta.peril).ok_or(bad_table(2))?;
        let q = pricing::quote(peril, &pts, to_u32(trigger_mm)?, to_u128(payout)?, &self.params_now())?;
        Ok((U256::from(q.premium), U256::from(q.p_ppm), U256::from(q.se_ppm), U256::from(q.rate_ppm)))
    }

    /// Largest additional payout that fits under the caps right now.
    pub fn headroom(&self, table_id: U256) -> Result<U256, EngineError> {
        let (meta, _) = self.table(table_id)?;
        let capital = self.capital()?;
        let rp = to_u128(self.exposure.get(cap_key(meta.region, meta.peril)))?;
        let total = to_u128(self.total_exposure.get())?;
        let cap = self.cap_bps.get(cap_key(meta.region, meta.peril)).to::<u32>();
        let util = self.max_util_bps.get().to::<u32>();
        Ok(U256::from(solvency::headroom(capital, rp, total, cap, util)))
    }

    // --------------------------------------------------- policy book (writes)

    /// Called by the PolicyBook when a policy is bought. Reverts if it would breach a cap.
    pub fn reserve(&mut self, table_id: U256, payout: U256) -> Result<(), EngineError> {
        self.only_book()?;
        let (meta, _) = self.table(table_id)?;
        if !meta.enabled {
            return Err(EngineError::TableDisabled(TableDisabled {}));
        }
        let amount = to_u128(payout)?;
        let key = cap_key(meta.region, meta.peril);
        let capital = self.capital()?;
        let (new_rp, new_total) = solvency::check_reserve(
            capital,
            to_u128(self.exposure.get(key))?,
            to_u128(self.total_exposure.get())?,
            amount,
            self.cap_bps.get(key).to::<u32>(),
            self.max_util_bps.get().to::<u32>(),
        )?;
        self.exposure.setter(key).set(U256::from(new_rp));
        self.total_exposure.set(U256::from(new_total));
        self.vm().log(Reserved {
            tableId: table_id,
            payout,
            regionPerilExposure: U256::from(new_rp),
            totalExposure: U256::from(new_total),
        });
        Ok(())
    }

    /// Called by the PolicyBook when a policy expires unpaid, is paid out, or is cancelled.
    /// Works even if the table has since been disabled.
    pub fn release(&mut self, table_id: U256, payout: U256) -> Result<(), EngineError> {
        self.only_book()?;
        let (meta, _) = self.table(table_id)?;
        let key = cap_key(meta.region, meta.peril);
        let (new_rp, new_total) = solvency::check_release(
            to_u128(self.exposure.get(key))?,
            to_u128(self.total_exposure.get())?,
            to_u128(payout)?,
        )?;
        self.exposure.setter(key).set(U256::from(new_rp));
        self.total_exposure.set(U256::from(new_total));
        self.vm().log(Released {
            tableId: table_id,
            payout,
            regionPerilExposure: U256::from(new_rp),
            totalExposure: U256::from(new_total),
        });
        Ok(())
    }

    // ------------------------------------------------------------ owner admin

    /// Set-once: the owner can never re-point the book after it is wired.
    pub fn set_book(&mut self, book: Address) -> Result<(), EngineError> {
        self.only_owner()?;
        if book == Address::ZERO {
            return Err(EngineError::ZeroAddress(ZeroAddress {}));
        }
        if self.book.get() != Address::ZERO {
            return Err(EngineError::AlreadySet(AlreadySet {}));
        }
        self.book.set(book);
        self.vm().log(BookSet { book });
        Ok(())
    }

    /// Set-once: the owner can never re-point the vault after it is wired.
    pub fn set_vault(&mut self, vault: Address) -> Result<(), EngineError> {
        self.only_owner()?;
        if vault == Address::ZERO {
            return Err(EngineError::ZeroAddress(ZeroAddress {}));
        }
        if self.vault.get() != Address::ZERO {
            return Err(EngineError::AlreadySet(AlreadySet {}));
        }
        self.vault.set(vault);
        self.vm().log(VaultSet { vault });
        Ok(())
    }

    pub fn set_pricing_params(&mut self, margin_k_bps: U256, floor_ppm: U256, loading_bps: U256, max_rate_ppm: U256, max_util_bps: U256) -> Result<(), EngineError> {
        self.only_owner()?;
        self.set_params_checked(margin_k_bps, floor_ppm, loading_bps, max_rate_ppm, max_util_bps)
    }

    /// Cap for a (region, peril) as basis points of vault capital. 0 blocks new policies there.
    pub fn set_cap(&mut self, region: u8, peril: u8, cap_bps: U256) -> Result<(), EngineError> {
        self.only_owner()?;
        if Peril::from_u8(peril).is_none() || cap_bps > U256::from(10_000u32) {
            return Err(EngineError::BadParams(BadParams {}));
        }
        self.cap_bps.setter(cap_key(region, peril)).set(cap_bps);
        self.vm().log(CapSet { region, peril, capBps: cap_bps });
        Ok(())
    }

    /// Create or replace a table. The region and peril of an existing table cannot change, since
    /// outstanding exposure is booked under them. Replacing points only affects future quotes.
    pub fn load_table(&mut self, table_id: U256, region: u8, peril: u8, levels: Vec<u32>, p_ppm: Vec<u32>, se_ppm: Vec<u32>) -> Result<(), EngineError> {
        self.only_owner()?;
        let peril_enum = Peril::from_u8(peril).ok_or(bad_table(2))?;
        let pts = pricing::zip_points(&levels, &p_ppm, &se_ppm).ok_or(bad_table(8))?;
        pricing::validate_table(peril_enum, &pts)?;

        let old = unpack_meta(self.table_meta.get(table_id));
        if old.exists && (old.region != region || old.peril != peril) {
            return Err(bad_table(9));
        }

        {
            let mut v = self.table_points.setter(table_id);
            while v.pop().is_some() {}
            for p in &pts {
                v.push(pack_point(p));
            }
        }
        let enabled = if old.exists { old.enabled } else { true };
        self.table_meta.setter(table_id).set(pack_meta(enabled, region, peril));
        self.vm().log(TableLoaded {
            tableId: table_id,
            region,
            peril,
            points: U256::from(pts.len()),
        });
        Ok(())
    }

    /// Stop selling new cover on a table (existing policies are unaffected).
    pub fn set_table_enabled(&mut self, table_id: U256, enabled: bool) -> Result<(), EngineError> {
        self.only_owner()?;
        let m = unpack_meta(self.table_meta.get(table_id));
        if !m.exists {
            return Err(EngineError::UnknownTable(UnknownTable {}));
        }
        self.table_meta.setter(table_id).set(pack_meta(enabled, m.region, m.peril));
        self.vm().log(TableEnabled { tableId: table_id, enabled });
        Ok(())
    }

    // ------------------------------------------------ two-step ownership

    pub fn transfer_ownership(&mut self, new_owner: Address) -> Result<(), EngineError> {
        self.only_owner()?;
        if new_owner == Address::ZERO {
            return Err(EngineError::ZeroAddress(ZeroAddress {}));
        }
        self.pending_owner.set(new_owner);
        self.vm().log(OwnershipTransferStarted {
            previousOwner: self.owner.get(),
            newOwner: new_owner,
        });
        Ok(())
    }

    pub fn accept_ownership(&mut self) -> Result<(), EngineError> {
        let pending = self.pending_owner.get();
        if pending == Address::ZERO || self.vm().msg_sender() != pending {
            return Err(EngineError::NotPendingOwner(NotPendingOwner {}));
        }
        let previous = self.owner.get();
        self.owner.set(pending);
        self.pending_owner.set(Address::ZERO);
        self.vm().log(OwnershipTransferred {
            previousOwner: previous,
            newOwner: pending,
        });
        Ok(())
    }
}

#[cfg(test)]
mod contract_tests {
    use super::*;
    use alloy_primitives::keccak256;
    use stylus_sdk::testing::*;

    const OWNER: u8 = 1;
    const BOOK: u8 = 2;
    const VAULT: u8 = 3;
    const STRANGER: u8 = 4;
    const T_DROUGHT: u64 = 1; // region 0, drought
    const T_FLOOD: u64 = 2; // region 1, flood
    const USD: u128 = 1_000_000; // 6 decimals

    fn addr(n: u8) -> Address {
        Address::from([n; 20])
    }

    fn tid(n: u64) -> U256 {
        U256::from(n)
    }

    fn set_vault_assets(vm: &TestVM, assets: u128) {
        vm.clear_mocks();
        let sel = keccak256("totalAssets()")[..4].to_vec();
        vm.mock_static_call(addr(VAULT), sel, Ok(U256::from(assets).to_be_bytes::<32>().to_vec()));
    }

    /// Engine with a book, a vault holding 1_000_000 USD, one drought table (region 0)
    /// capped at 25% and one flood table (region 1) capped at 60%.
    fn setup(vm: &TestVM) -> DryspellEngine {
        let mut c = DryspellEngine::from(vm);
        c.constructor(addr(OWNER)).unwrap();
        vm.set_sender(addr(OWNER));
        c.set_book(addr(BOOK)).unwrap();
        c.set_vault(addr(VAULT)).unwrap();
        c.set_cap(0, 0, U256::from(2_500u32)).unwrap();
        c.set_cap(1, 1, U256::from(6_000u32)).unwrap();
        c.load_table(tid(T_DROUGHT), 0, 0, vec![100, 200, 300], vec![5_000, 20_000, 100_000], vec![2_000, 6_000, 30_000]).unwrap();
        c.load_table(tid(T_FLOOD), 1, 1, vec![200, 150, 100], vec![5_000, 20_000, 100_000], vec![2_000, 6_000, 30_000]).unwrap();
        set_vault_assets(vm, 1_000_000 * USD);
        c
    }

    #[test]
    fn constructor_sets_owner_and_defaults() {
        let vm = TestVM::new();
        let mut c = DryspellEngine::from(&vm);
        assert!(matches!(c.constructor(Address::ZERO), Err(EngineError::ZeroAddress(_))));
        c.constructor(addr(OWNER)).unwrap();
        assert_eq!(c.owner(), addr(OWNER));
        assert_eq!(c.engine_kind(), "stylus");
        let (k, floor, loading, max_rate, util) = c.params();
        assert_eq!((k, floor, loading, max_rate, util), (U256::from(15_000), U256::from(2_000), U256::from(2_500), U256::from(700_000), U256::from(8_000)));
    }

    #[test]
    fn only_owner_can_administer() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        vm.set_sender(addr(STRANGER));
        assert!(matches!(c.set_book(addr(9)), Err(EngineError::NotOwner(_))));
        assert!(matches!(c.set_vault(addr(9)), Err(EngineError::NotOwner(_))));
        assert!(matches!(c.set_cap(0, 0, U256::from(1)), Err(EngineError::NotOwner(_))));
        assert!(matches!(c.set_pricing_params(U256::from(1), U256::from(1), U256::from(1), U256::from(1), U256::from(1)), Err(EngineError::NotOwner(_))));
        assert!(matches!(c.set_table_enabled(tid(T_DROUGHT), false), Err(EngineError::NotOwner(_))));
        assert!(matches!(c.transfer_ownership(addr(STRANGER)), Err(EngineError::NotOwner(_))));
        assert!(matches!(c.load_table(tid(5), 0, 0, vec![1, 2], vec![1, 2], vec![0, 0]), Err(EngineError::NotOwner(_))));
        // the book address cannot administer either
        vm.set_sender(addr(BOOK));
        assert!(matches!(c.set_book(addr(9)), Err(EngineError::NotOwner(_))));
        assert_eq!(c.book(), addr(BOOK));
    }

    #[test]
    fn quote_matches_pure_pricing() {
        let vm = TestVM::new();
        let c = setup(&vm);
        let (premium, p, se, rate) = c.quote(tid(T_DROUGHT), U256::from(150), U256::from(1_000 * USD)).unwrap();
        assert_eq!((premium, p, se, rate), (U256::from(23_125_000u64), U256::from(12_500), U256::from(4_000), U256::from(23_125)));
        let (premium, ..) = c.quote(tid(T_FLOOD), U256::from(175), U256::from(1_000 * USD)).unwrap();
        assert_eq!(premium, U256::from(23_125_000u64));
    }

    #[test]
    fn quote_rejections() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        let pay = U256::from(1_000 * USD);
        assert!(matches!(c.quote(tid(99), U256::from(150), pay), Err(EngineError::UnknownTable(_))));
        assert!(matches!(c.quote(tid(T_DROUGHT), U256::from(99), pay), Err(EngineError::OutOfRange(_))));
        assert!(matches!(c.quote(tid(T_DROUGHT), U256::from(301), pay), Err(EngineError::OutOfRange(_))));
        assert!(matches!(c.quote(tid(T_DROUGHT), U256::from(u64::MAX), pay), Err(EngineError::OutOfRange(_))));
        assert!(matches!(c.quote(tid(T_DROUGHT), U256::from(150), U256::ZERO), Err(EngineError::ZeroPayout(_))));
        assert!(matches!(c.quote(tid(T_DROUGHT), U256::from(150), U256::MAX), Err(EngineError::AmountTooLarge(_))));
        c.set_table_enabled(tid(T_DROUGHT), false).unwrap();
        assert!(matches!(c.quote(tid(T_DROUGHT), U256::from(150), pay), Err(EngineError::TableDisabled(_))));
        c.set_table_enabled(tid(T_DROUGHT), true).unwrap();
        // rate cap
        c.set_pricing_params(U256::from(15_000), U256::from(2_000), U256::from(2_500), U256::from(100_000), U256::from(8_000)).unwrap();
        assert!(matches!(c.quote(tid(T_DROUGHT), U256::from(300), pay), Err(EngineError::RateTooHigh(_))));
    }

    #[test]
    fn param_validation() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        let ok = |c: &mut DryspellEngine, max_rate: u64, util: u64| c.set_pricing_params(U256::from(15_000), U256::from(2_000), U256::from(2_500), U256::from(max_rate), U256::from(util));
        assert!(ok(&mut c, 700_000, 8_000).is_ok());
        assert!(matches!(ok(&mut c, 1_000_000, 8_000), Err(EngineError::BadParams(_)))); // rate cap must be < 100%
        assert!(matches!(ok(&mut c, 0, 8_000), Err(EngineError::BadParams(_))));
        assert!(matches!(ok(&mut c, 700_000, 0), Err(EngineError::BadParams(_))));
        assert!(matches!(ok(&mut c, 700_000, 10_001), Err(EngineError::BadParams(_))));
        assert!(matches!(ok(&mut c, 700_000, 9_501), Err(EngineError::BadParams(_)))); // above the 95% bound
        assert!(ok(&mut c, 700_000, 9_500).is_ok()); // the bound itself is allowed
        assert!(matches!(c.set_cap(0, 0, U256::from(10_001)), Err(EngineError::BadParams(_))));
        assert!(matches!(c.set_cap(0, 7, U256::from(1)), Err(EngineError::BadParams(_)))); // unknown peril
    }

    #[test]
    fn reserve_only_by_book() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        for who in [OWNER, STRANGER] {
            vm.set_sender(addr(who));
            assert!(matches!(c.reserve(tid(T_DROUGHT), U256::from(USD)), Err(EngineError::NotBook(_))));
            assert!(matches!(c.release(tid(T_DROUGHT), U256::from(USD)), Err(EngineError::NotBook(_))));
        }
        assert_eq!(c.total_exposure(), U256::ZERO);
    }

    #[test]
    fn region_peril_cap_boundary() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        vm.set_sender(addr(BOOK));
        // 25% of 1_000_000 USD
        c.reserve(tid(T_DROUGHT), U256::from(250_000 * USD)).unwrap();
        assert_eq!(c.exposure_of(0, 0), U256::from(250_000 * USD));
        assert_eq!(c.total_exposure(), U256::from(250_000 * USD));
        assert!(matches!(c.reserve(tid(T_DROUGHT), U256::from(1)), Err(EngineError::CapBreached(CapBreached { which: 1 }))));
        // failed reserve left state untouched
        assert_eq!(c.total_exposure(), U256::from(250_000 * USD));
        assert_eq!(c.headroom(tid(T_DROUGHT)).unwrap(), U256::ZERO);
    }

    #[test]
    fn total_utilization_cap_binds_across_regions() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        vm.set_sender(addr(BOOK));
        c.reserve(tid(T_DROUGHT), U256::from(250_000 * USD)).unwrap();
        c.reserve(tid(T_FLOOD), U256::from(550_000 * USD)).unwrap(); // total 800_000 = 80%
        assert!(matches!(c.reserve(tid(T_FLOOD), U256::from(1)), Err(EngineError::CapBreached(CapBreached { which: 2 }))));
        assert_eq!(c.headroom(tid(T_FLOOD)).unwrap(), U256::ZERO);
    }

    #[test]
    fn capital_is_read_from_the_vault_each_time() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        vm.set_sender(addr(BOOK));
        c.reserve(tid(T_DROUGHT), U256::from(100_000 * USD)).unwrap();
        // underwriters withdraw: capital halves, so the 25% cap is now 125_000
        set_vault_assets(&vm, 500_000 * USD);
        assert_eq!(c.headroom(tid(T_DROUGHT)).unwrap(), U256::from(25_000 * USD));
        assert!(matches!(c.reserve(tid(T_DROUGHT), U256::from(25_001 * USD)), Err(EngineError::CapBreached(_))));
        c.reserve(tid(T_DROUGHT), U256::from(25_000 * USD)).unwrap();
    }

    #[test]
    fn vault_problems_block_reserve() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        vm.set_sender(addr(BOOK));
        // vault reverts
        vm.clear_mocks();
        vm.mock_static_call(addr(VAULT), keccak256("totalAssets()")[..4].to_vec(), Err(vec![1]));
        assert!(matches!(c.reserve(tid(T_DROUGHT), U256::from(USD)), Err(EngineError::VaultCallFailed(_))));
        // empty vault
        set_vault_assets(&vm, 0);
        assert!(matches!(c.reserve(tid(T_DROUGHT), U256::from(USD)), Err(EngineError::NoCapital(_))));
        // vault returns more than fits in u128
        vm.clear_mocks();
        vm.mock_static_call(addr(VAULT), keccak256("totalAssets()")[..4].to_vec(), Ok(U256::MAX.to_be_bytes::<32>().to_vec()));
        assert!(matches!(c.reserve(tid(T_DROUGHT), U256::from(USD)), Err(EngineError::AmountTooLarge(_))));
        assert_eq!(c.total_exposure(), U256::ZERO);
    }

    #[test]
    fn no_cap_means_no_cover() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        vm.set_sender(addr(OWNER));
        c.load_table(tid(7), 2, 0, vec![10, 20], vec![1_000, 2_000], vec![100, 100]).unwrap(); // region 2 has no cap set
        vm.set_sender(addr(BOOK));
        assert!(matches!(c.reserve(tid(7), U256::from(USD)), Err(EngineError::NoCap(_))));
    }

    #[test]
    fn release_accounting_and_disabled_tables() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        vm.set_sender(addr(BOOK));
        c.reserve(tid(T_DROUGHT), U256::from(100 * USD)).unwrap();
        assert!(matches!(c.release(tid(T_DROUGHT), U256::from(101 * USD)), Err(EngineError::ReleaseTooLarge(_))));
        assert!(matches!(c.release(tid(T_DROUGHT), U256::ZERO), Err(EngineError::ZeroPayout(_))));
        // releasing from the wrong table cannot free another region's exposure
        assert!(matches!(c.release(tid(T_FLOOD), U256::from(1)), Err(EngineError::ReleaseTooLarge(_))));
        // disabling a table blocks new reserves but never traps existing exposure
        vm.set_sender(addr(OWNER));
        c.set_table_enabled(tid(T_DROUGHT), false).unwrap();
        vm.set_sender(addr(BOOK));
        assert!(matches!(c.reserve(tid(T_DROUGHT), U256::from(1)), Err(EngineError::TableDisabled(_))));
        c.release(tid(T_DROUGHT), U256::from(40 * USD)).unwrap();
        c.release(tid(T_DROUGHT), U256::from(60 * USD)).unwrap();
        assert_eq!(c.total_exposure(), U256::ZERO);
        assert_eq!(c.exposure_of(0, 0), U256::ZERO);
    }

    #[test]
    fn table_loading_rules() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        let id = tid(T_DROUGHT);
        // invalid tables
        assert!(matches!(c.load_table(id, 0, 0, vec![100], vec![5_000], vec![0]), Err(EngineError::BadTable(BadTable { code: 1 }))));
        assert!(matches!(c.load_table(id, 0, 9, vec![100, 200], vec![1, 2], vec![0, 0]), Err(EngineError::BadTable(BadTable { code: 2 }))));
        assert!(matches!(c.load_table(id, 0, 0, vec![200, 100], vec![1, 2], vec![0, 0]), Err(EngineError::BadTable(BadTable { code: 3 }))));
        assert!(matches!(c.load_table(id, 0, 0, vec![100, 200], vec![2, 1], vec![0, 0]), Err(EngineError::BadTable(BadTable { code: 4 }))));
        assert!(matches!(c.load_table(id, 0, 0, vec![100, 200], vec![1, 2_000_000], vec![0, 0]), Err(EngineError::BadTable(BadTable { code: 5 }))));
        assert!(matches!(c.load_table(id, 0, 0, vec![100, 200], vec![0, 5], vec![0, 0]), Err(EngineError::BadTable(BadTable { code: 6 }))));
        assert!(matches!(c.load_table(id, 0, 0, vec![100, 200], vec![1, 2], vec![0]), Err(EngineError::BadTable(BadTable { code: 8 }))));
        // region/peril cannot change once a table exists (exposure is booked under them)
        assert!(matches!(c.load_table(id, 3, 0, vec![100, 200], vec![1, 2], vec![0, 0]), Err(EngineError::BadTable(BadTable { code: 9 }))));
        assert!(matches!(c.load_table(id, 0, 1, vec![200, 100], vec![1, 2], vec![0, 0]), Err(EngineError::BadTable(BadTable { code: 9 }))));
        // a failed reload left the old table intact
        assert_eq!(c.table_points(id).unwrap().0, vec![100, 200, 300]);
        // a valid reload replaces points (shorter table) and keeps the enabled flag
        c.set_table_enabled(id, false).unwrap();
        c.load_table(id, 0, 0, vec![50, 90], vec![1_000, 3_000], vec![100, 100]).unwrap();
        let (levels, p, se) = c.table_points(id).unwrap();
        assert_eq!((levels, p, se), (vec![50, 90], vec![1_000, 3_000], vec![100, 100]));
        assert_eq!(c.table_info(id), (true, false, 0, 0));
    }

    #[test]
    fn wiring_is_set_once() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        assert_eq!(c.book(), addr(BOOK));
        assert_eq!(c.vault(), addr(VAULT));
        // the owner cannot re-point the book or the vault, not even to the same address
        assert!(matches!(c.set_book(addr(9)), Err(EngineError::AlreadySet(_))));
        assert!(matches!(c.set_book(addr(BOOK)), Err(EngineError::AlreadySet(_))));
        assert!(matches!(c.set_vault(addr(9)), Err(EngineError::AlreadySet(_))));
        assert!(matches!(c.set_vault(addr(VAULT)), Err(EngineError::AlreadySet(_))));
        assert_eq!(c.book(), addr(BOOK));
        assert_eq!(c.vault(), addr(VAULT));
        // a zero address is still rejected first
        let vm2 = TestVM::new();
        let mut fresh = DryspellEngine::from(&vm2);
        fresh.constructor(addr(OWNER)).unwrap();
        vm2.set_sender(addr(OWNER));
        assert!(matches!(fresh.set_book(Address::ZERO), Err(EngineError::ZeroAddress(_))));
        assert!(matches!(fresh.set_vault(Address::ZERO), Err(EngineError::ZeroAddress(_))));
        fresh.set_book(addr(1)).unwrap();
        fresh.set_vault(addr(2)).unwrap();
    }

    #[test]
    fn new_owner_cannot_repoint_wiring_either() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        vm.set_sender(addr(OWNER));
        c.transfer_ownership(addr(STRANGER)).unwrap();
        vm.set_sender(addr(STRANGER));
        c.accept_ownership().unwrap();
        assert!(matches!(c.set_book(addr(STRANGER)), Err(EngineError::AlreadySet(_))));
        assert!(matches!(c.set_vault(addr(STRANGER)), Err(EngineError::AlreadySet(_))));
    }

    #[test]
    fn two_step_ownership() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        // nobody is pending yet
        vm.set_sender(addr(STRANGER));
        assert!(matches!(c.accept_ownership(), Err(EngineError::NotPendingOwner(_))));
        vm.set_sender(addr(OWNER));
        assert!(matches!(c.transfer_ownership(Address::ZERO), Err(EngineError::ZeroAddress(_))));
        c.transfer_ownership(addr(STRANGER)).unwrap();
        // still the owner until accepted
        assert_eq!(c.owner(), addr(OWNER));
        vm.set_sender(addr(BOOK));
        assert!(matches!(c.accept_ownership(), Err(EngineError::NotPendingOwner(_))));
        vm.set_sender(addr(STRANGER));
        c.accept_ownership().unwrap();
        assert_eq!(c.owner(), addr(STRANGER));
        assert_eq!(c.pending_owner(), Address::ZERO);
        // old owner lost all power
        vm.set_sender(addr(OWNER));
        assert!(matches!(c.set_book(addr(9)), Err(EngineError::NotOwner(_))));
        // and the accept cannot be replayed
        vm.set_sender(addr(STRANGER));
        assert!(matches!(c.accept_ownership(), Err(EngineError::NotPendingOwner(_))));
    }

    #[test]
    fn events_are_emitted() {
        let vm = TestVM::new();
        let mut c = setup(&vm);
        vm.set_sender(addr(BOOK));
        let before = vm.get_emitted_logs().len();
        c.reserve(tid(T_DROUGHT), U256::from(USD)).unwrap();
        c.release(tid(T_DROUGHT), U256::from(USD)).unwrap();
        assert_eq!(vm.get_emitted_logs().len(), before + 2);
    }

    /// Every table the data layer offers must load and price sanely.
    #[test]
    fn real_exceedance_tables_validate_and_price() {
        let json: serde_json::Value = serde_json::from_str(include_str!("../../../data/generated/exceedance.json")).unwrap();
        let params = Params { margin_k_bps: 15_000, floor_ppm: 2_000, loading_bps: 2_500, max_rate_ppm: 700_000 };
        let mut checked = 0;
        for loc in json["locations"].as_array().unwrap() {
            for season in loc["seasons"].as_array().unwrap() {
                for peril in season["perils"].as_array().unwrap() {
                    if !peril["offered"].as_bool().unwrap() {
                        continue;
                    }
                    let kind = if peril["peril"] == "drought" { Peril::Drought } else { Peril::Flood };
                    let pts: Vec<Point> = peril["table"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|r| Point {
                            level: r["level_mm"].as_u64().unwrap() as u32,
                            p_ppm: r["p_ppm"].as_u64().unwrap() as u32,
                            se_ppm: r["se_ppm"].as_u64().unwrap() as u32,
                        })
                        .collect();
                    let name = format!("{}/{}/{:?}", loc["id"], season["id"], kind);
                    pricing::validate_table(kind, &pts).unwrap_or_else(|e| panic!("{name}: {e:?}"));
                    let payout = 1_000 * USD;
                    let mut sellable = 0;
                    for p in &pts {
                        match pricing::quote(kind, &pts, p.level, payout, &params) {
                            Ok(q) => {
                                // never cheaper than fair value, never more than the payout
                                assert!(q.premium >= payout * p.p_ppm as u128 / pricing::PPM, "{name}");
                                assert!(q.premium < payout, "{name}");
                                sellable += 1;
                            }
                            // coin-flip cover is refused by the rate cap; that is intended, but
                            // only where the payout probability is genuinely high
                            Err(PriceError::RateTooHigh) => assert!(p.p_ppm >= 300_000, "{name} @{}: refused at p={}", p.level, p.p_ppm),
                            Err(e) => panic!("{name} @{}: {e:?}", p.level),
                        }
                    }
                    // the tail, where cover is actually bought, must stay sellable
                    assert!(sellable >= 10, "{name}: only {sellable} sellable points");
                    checked += 1;
                }
            }
        }
        assert_eq!(checked, 16, "expected 11 drought + 5 flood offered tables");
    }
}

/// Test vectors that pin the Solidity fallback engine to this implementation.
/// `contracts/solidity/test/vectors/engine_vectors.json` is generated here and replayed by
/// `contracts/solidity/test/EngineParity.t.sol`. Regenerate with:
///   DRYSPELL_WRITE_VECTORS=1 cargo test --lib parity_vectors
#[cfg(test)]
mod parity {
    use super::*;
    use serde_json::{json, Value};

    const PATH: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../solidity/test/vectors/engine_vectors.json");

    fn real_table(loc: &str, season: &str, peril_idx: usize) -> (Peril, Vec<Point>) {
        let j: Value = serde_json::from_str(include_str!("../../../data/generated/exceedance.json")).unwrap();
        for l in j["locations"].as_array().unwrap() {
            if l["id"] != loc {
                continue;
            }
            for s in l["seasons"].as_array().unwrap() {
                if s["id"] != season {
                    continue;
                }
                let p = &s["perils"][peril_idx];
                let kind = if peril_idx == 0 { Peril::Drought } else { Peril::Flood };
                let pts = p["table"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|r| Point {
                        level: r["level_mm"].as_u64().unwrap() as u32,
                        p_ppm: r["p_ppm"].as_u64().unwrap() as u32,
                        se_ppm: r["se_ppm"].as_u64().unwrap() as u32,
                    })
                    .collect();
                return (kind, pts);
            }
        }
        panic!("table {loc}/{season} not found");
    }

    fn err_name(e: PriceError) -> &'static str {
        match e {
            PriceError::ZeroPayout => "ZeroPayout",
            PriceError::OutOfRange | PriceError::EmptyTable => "OutOfRange",
            PriceError::RateTooHigh => "RateTooHigh",
            PriceError::Overflow => "MathOverflow",
        }
    }

    fn build() -> Value {
        let mut tables: Vec<(&str, Peril, Vec<Point>)> = vec![
            ("jodhpur/jjas/drought", real_table("jodhpur", "jjas", 0).0, real_table("jodhpur", "jjas", 0).1),
            ("khonkaen/mjjaso/flood", real_table("khonkaen", "mjjaso", 1).0, real_table("khonkaen", "mjjaso", 1).1),
            ("dodoma/ndjfma/drought", real_table("dodoma", "ndjfma", 0).0, real_table("dodoma", "ndjfma", 0).1),
            ("garissa/short/flood", real_table("garissa", "short", 1).0, real_table("garissa", "short", 1).1),
        ];
        // synthetic tables that exercise the decreasing-se and tiny-slope rounding branches
        tables.push((
            "synthetic/drought",
            Peril::Drought,
            vec![
                Point { level: 10, p_ppm: 1_000, se_ppm: 500 },
                Point { level: 20, p_ppm: 3_001, se_ppm: 301 },
                Point { level: 37, p_ppm: 9_000, se_ppm: 100 },
                Point { level: 50, p_ppm: 200_000, se_ppm: 99 },
            ],
        ));
        tables.push((
            "synthetic/flood",
            Peril::Flood,
            vec![
                Point { level: 300, p_ppm: 1_000, se_ppm: 0 },
                Point { level: 250, p_ppm: 1_007, se_ppm: 20 },
                Point { level: 241, p_ppm: 50_000, se_ppm: 10 },
                Point { level: 100, p_ppm: 400_000, se_ppm: 7 },
            ],
        ));
        let params = [
            Params { margin_k_bps: 15_000, floor_ppm: 2_000, loading_bps: 2_500, max_rate_ppm: 700_000 },
            Params { margin_k_bps: 5_000, floor_ppm: 500, loading_bps: 0, max_rate_ppm: 300_000 },
            Params { margin_k_bps: 30_000, floor_ppm: 10_000, loading_bps: 10_000, max_rate_ppm: 900_000 },
        ];
        let payouts: [u128; 8] = [0, 1, 999_999, 1_000_000, 123_456_789, 1_000_000_000_000, u128::MAX / 500_000, u128::MAX / 3];

        let mut vectors = Vec::new();
        for (ti, (_, peril, pts)) in tables.iter().enumerate() {
            let mut triggers: Vec<u32> = vec![0, u32::MAX];
            for w in pts.windows(2) {
                triggers.push(w[0].level);
                triggers.push(w[1].level);
                triggers.push((w[0].level + w[1].level) / 2);
                triggers.push((w[0].level + w[1].level) / 2 + 1);
                triggers.push(w[0].level.min(w[1].level) + 1);
            }
            let (lo, hi) = (pts.iter().map(|p| p.level).min().unwrap(), pts.iter().map(|p| p.level).max().unwrap());
            triggers.extend([lo - 1, lo, hi, hi + 1]);
            triggers.sort();
            triggers.dedup();
            for (pi, params) in params.iter().enumerate() {
                for &level in &triggers {
                    for &payout in &payouts {
                        // only a few payouts per trigger keep the file small but cover every branch
                        let r = pricing::quote(*peril, pts, level, payout, params);
                        let v = match r {
                            Ok(q) => json!({"table": ti.to_string(), "params": pi.to_string(), "level": level.to_string(), "payout": payout.to_string(),
                                "ok": true, "premium": q.premium.to_string(), "p": q.p_ppm.to_string(), "se": q.se_ppm.to_string(), "rate": q.rate_ppm.to_string(), "err": ""}),
                            Err(e) => json!({"table": ti.to_string(), "params": pi.to_string(), "level": level.to_string(), "payout": payout.to_string(),
                                "ok": false, "premium": "0", "p": "0", "se": "0", "rate": "0", "err": err_name(e)}),
                        };
                        vectors.push(v);
                    }
                }
            }
        }

        let tables_json: Vec<Value> = tables
            .iter()
            .map(|(name, peril, pts)| {
                json!({
                    "name": name,
                    "peril": if *peril == Peril::Drought { 0 } else { 1 },
                    "levels": pts.iter().map(|p| p.level).collect::<Vec<_>>(),
                    "p": pts.iter().map(|p| p.p_ppm).collect::<Vec<_>>(),
                    "se": pts.iter().map(|p| p.se_ppm).collect::<Vec<_>>(),
                })
            })
            .collect();
        let params_json: Vec<Value> = params
            .iter()
            .map(|p| json!({"k": p.margin_k_bps, "floor": p.floor_ppm, "loading": p.loading_bps, "maxRate": p.max_rate_ppm}))
            .collect();
        // column-oriented so the Solidity side can read each column with parseJson*Array
        let col = |k: &str| -> Vec<Value> { vectors.iter().map(|v| v[k].clone()).collect() };
        json!({
            "tables": tables_json,
            "params": params_json,
            "vectors": {
                "table": col("table"), "params": col("params"), "level": col("level"), "payout": col("payout"),
                "ok": col("ok"), "premium": col("premium"), "p": col("p"), "se": col("se"), "rate": col("rate"), "err": col("err"),
            }
        })
    }

    #[test]
    fn parity_vectors() {
        let fresh = serde_json::to_string(&build()).unwrap() + "\n";
        if std::env::var("DRYSPELL_WRITE_VECTORS").is_ok() {
            std::fs::create_dir_all(std::path::Path::new(PATH).parent().unwrap()).unwrap();
            std::fs::write(PATH, &fresh).unwrap();
            return;
        }
        let committed = std::fs::read_to_string(PATH).expect("vectors missing; run with DRYSPELL_WRITE_VECTORS=1");
        assert!(committed == fresh, "engine vectors are stale; regenerate with DRYSPELL_WRITE_VECTORS=1");
    }
}
