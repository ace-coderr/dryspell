//! Solvency engine: exposure caps per (region, peril) and across the whole book.
//!
//! Exposure is the sum of maximum payouts of active policies. A new policy is
//! rejected if, after adding its payout,
//!   - exposure(region, peril)  > cap_bps(region, peril) / 10_000 * capital, or
//!   - total exposure           > max_utilization_bps   / 10_000 * capital.
//! `capital` is the underwriter vault's total assets (read from the vault by the
//! contract, never supplied by the caller).

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SolvencyError {
    ZeroPayout,
    /// The vault holds no capital.
    NoCapital,
    /// No cap has been set for this (region, peril): nothing may be written there.
    NoCap,
    RegionPerilCapBreached,
    TotalCapBreached,
    Overflow,
    /// Release is larger than the recorded exposure.
    ReleaseTooLarge,
}

pub const BPS: u128 = 10_000;

/// Returns (new_region_peril_exposure, new_total_exposure) if the policy fits.
pub fn check_reserve(
    capital: u128,
    region_peril_exposure: u128,
    total_exposure: u128,
    payout: u128,
    cap_bps: u32,
    max_util_bps: u32,
) -> Result<(u128, u128), SolvencyError> {
    if payout == 0 {
        return Err(SolvencyError::ZeroPayout);
    }
    if capital == 0 {
        return Err(SolvencyError::NoCapital);
    }
    if cap_bps == 0 {
        return Err(SolvencyError::NoCap);
    }
    let new_rp = region_peril_exposure.checked_add(payout).ok_or(SolvencyError::Overflow)?;
    let new_total = total_exposure.checked_add(payout).ok_or(SolvencyError::Overflow)?;
    // new_rp / capital <= cap_bps / BPS   <=>   new_rp * BPS <= cap_bps * capital
    let lhs_rp = new_rp.checked_mul(BPS).ok_or(SolvencyError::Overflow)?;
    let rhs_rp = capital.checked_mul(cap_bps as u128).ok_or(SolvencyError::Overflow)?;
    if lhs_rp > rhs_rp {
        return Err(SolvencyError::RegionPerilCapBreached);
    }
    let lhs_t = new_total.checked_mul(BPS).ok_or(SolvencyError::Overflow)?;
    let rhs_t = capital.checked_mul(max_util_bps as u128).ok_or(SolvencyError::Overflow)?;
    if lhs_t > rhs_t {
        return Err(SolvencyError::TotalCapBreached);
    }
    Ok((new_rp, new_total))
}

/// Returns (new_region_peril_exposure, new_total_exposure) after releasing `payout`.
pub fn check_release(region_peril_exposure: u128, total_exposure: u128, payout: u128) -> Result<(u128, u128), SolvencyError> {
    if payout == 0 {
        return Err(SolvencyError::ZeroPayout);
    }
    if payout > region_peril_exposure || payout > total_exposure {
        return Err(SolvencyError::ReleaseTooLarge);
    }
    Ok((region_peril_exposure - payout, total_exposure - payout))
}

/// Largest extra payout that fits right now (0 if none).
pub fn headroom(capital: u128, region_peril_exposure: u128, total_exposure: u128, cap_bps: u32, max_util_bps: u32) -> u128 {
    let rp_max = capital.saturating_mul(cap_bps as u128) / BPS;
    let t_max = capital.saturating_mul(max_util_bps as u128) / BPS;
    rp_max
        .saturating_sub(region_peril_exposure)
        .min(t_max.saturating_sub(total_exposure))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exact_cap_passes_one_over_fails() {
        // capital 1_000_000, region cap 25% => 250_000
        assert_eq!(check_reserve(1_000_000, 0, 0, 250_000, 2_500, 8_000), Ok((250_000, 250_000)));
        assert_eq!(check_reserve(1_000_000, 0, 0, 250_001, 2_500, 8_000), Err(SolvencyError::RegionPerilCapBreached));
        // existing exposure counts
        assert_eq!(check_reserve(1_000_000, 200_000, 200_000, 50_000, 2_500, 8_000), Ok((250_000, 250_000)));
        assert_eq!(check_reserve(1_000_000, 200_000, 200_000, 50_001, 2_500, 8_000), Err(SolvencyError::RegionPerilCapBreached));
    }

    #[test]
    fn total_utilization_cap() {
        // each region well under its 40% cap, but total would exceed 80%
        assert_eq!(check_reserve(1_000_000, 100_000, 790_000, 10_000, 4_000, 8_000), Ok((110_000, 800_000)));
        assert_eq!(check_reserve(1_000_000, 100_000, 790_000, 10_001, 4_000, 8_000), Err(SolvencyError::TotalCapBreached));
    }

    #[test]
    fn degenerate_inputs() {
        assert_eq!(check_reserve(1_000_000, 0, 0, 0, 2_500, 8_000), Err(SolvencyError::ZeroPayout));
        assert_eq!(check_reserve(0, 0, 0, 1, 2_500, 8_000), Err(SolvencyError::NoCapital));
        assert_eq!(check_reserve(1_000_000, 0, 0, 1, 0, 8_000), Err(SolvencyError::NoCap));
        assert_eq!(check_reserve(1_000_000, 0, 0, 1, 2_500, 0), Err(SolvencyError::TotalCapBreached));
    }

    #[test]
    fn overflow_is_reported_not_wrapped() {
        assert_eq!(check_reserve(1_000_000, u128::MAX, 0, 1, 2_500, 8_000), Err(SolvencyError::Overflow));
        assert_eq!(check_reserve(1_000_000, 0, u128::MAX, 1, 2_500, 8_000), Err(SolvencyError::Overflow));
        // payout * 10_000 overflows u128
        assert_eq!(check_reserve(u128::MAX, 0, 0, u128::MAX / 2, 10_000, 10_000), Err(SolvencyError::Overflow));
    }

    #[test]
    fn release_accounting() {
        assert_eq!(check_release(300, 500, 200), Ok((100, 300)));
        assert_eq!(check_release(300, 500, 300), Ok((0, 200)));
        assert_eq!(check_release(300, 500, 301), Err(SolvencyError::ReleaseTooLarge));
        assert_eq!(check_release(300, 250, 260), Err(SolvencyError::ReleaseTooLarge));
        assert_eq!(check_release(300, 500, 0), Err(SolvencyError::ZeroPayout));
    }

    #[test]
    fn reserve_then_release_round_trips() {
        let (rp, t) = check_reserve(1_000_000, 10, 20, 5_000, 2_500, 8_000).unwrap();
        assert_eq!(check_release(rp, t, 5_000), Ok((10, 20)));
    }

    #[test]
    fn headroom_is_exactly_what_fits() {
        let cases = [(1_000_000u128, 0u128, 0u128, 2_500u32, 8_000u32), (1_000_000, 200_000, 790_000, 4_000, 8_000), (777_777, 12_345, 54_321, 1_234, 5_678)];
        for (cap, rp, total, cap_bps, util) in cases {
            let h = headroom(cap, rp, total, cap_bps, util);
            if h > 0 {
                assert!(check_reserve(cap, rp, total, h, cap_bps, util).is_ok(), "headroom must fit");
            }
            assert!(check_reserve(cap, rp, total, h + 1, cap_bps, util).is_err(), "headroom + 1 must not fit");
        }
        // already above the cap: no headroom, no underflow
        assert_eq!(headroom(1_000, 900, 900, 1_000, 8_000), 0);
    }
}
