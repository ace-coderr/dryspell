//! Fixed-point pricing engine. Pure integer math, no SDK types, so it can be unit
//! tested natively and audited on its own.
//!
//! A table is a list of points ordered by *increasing probability of payout*:
//!   - drought (pays when value <= trigger): levels strictly ascending
//!   - flood   (pays when value >= trigger): levels strictly descending
//! Each point carries `p_ppm` (fitted probability of payout in a season, parts per
//! million) and `se_ppm` (its bootstrap standard error). They come from
//! `data/generated/exceedance.json`.
//!
//! premium = ceil( payout * rate / 1e6 ), with
//!   margin = max( ceil(k * se), floor )
//!   rate   = ceil( (p + margin) * (1 + loading) )
//! Every division rounds in the pool's favour (up), and quotes are rejected when
//! the trigger lies outside the table (we have no data there) or when the rate
//! exceeds `max_rate_ppm`.

use alloc::vec::Vec;

pub const PPM: u128 = 1_000_000;
pub const BPS: u128 = 10_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Peril {
    Drought = 0,
    Flood = 1,
}

impl Peril {
    pub fn from_u8(v: u8) -> Option<Self> {
        match v {
            0 => Some(Peril::Drought),
            1 => Some(Peril::Flood),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Point {
    pub level: u32,
    pub p_ppm: u32,
    pub se_ppm: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Params {
    /// Risk margin multiplier on the standard error, in basis points (15_000 = 1.5x).
    pub margin_k_bps: u32,
    /// Minimum risk margin in ppm, applied even when `se` is tiny.
    pub floor_ppm: u32,
    /// Expense and profit loading in basis points (2_000 = +20%).
    pub loading_bps: u32,
    /// Quotes with a higher rate are rejected (ppm of payout).
    pub max_rate_ppm: u32,
}

impl Params {
    /// Parameter sanity: the rate cap must stay below 100% of the payout.
    pub fn is_valid(&self) -> bool {
        self.max_rate_ppm > 0
            && (self.max_rate_ppm as u128) < PPM
            && self.loading_bps <= 100_000
            && self.margin_k_bps <= 1_000_000
            && (self.floor_ppm as u128) < PPM
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PriceError {
    ZeroPayout,
    /// Trigger is outside the range covered by the table.
    OutOfRange,
    EmptyTable,
    RateTooHigh,
    Overflow,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableError {
    TooFewPoints,
    BadPeril,
    /// Levels are not strictly monotone in the direction the peril requires.
    LevelsNotMonotone,
    /// Probability decreases as the trigger gets easier to hit.
    ProbabilityNotMonotone,
    ProbabilityTooLarge,
    /// A point has p = 0, which would price cover at the margin floor only.
    ZeroProbability,
    TooManyPoints,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Quote {
    pub premium: u128,
    pub p_ppm: u128,
    pub se_ppm: u128,
    pub rate_ppm: u128,
}

pub const MAX_POINTS: usize = 32;

/// Validate a table before it is stored.
pub fn validate_table(peril: Peril, pts: &[Point]) -> Result<(), TableError> {
    if pts.len() < 2 {
        return Err(TableError::TooFewPoints);
    }
    if pts.len() > MAX_POINTS {
        return Err(TableError::TooManyPoints);
    }
    for (i, p) in pts.iter().enumerate() {
        if p.p_ppm == 0 {
            return Err(TableError::ZeroProbability);
        }
        if (p.p_ppm as u128) > PPM || (p.se_ppm as u128) > PPM {
            return Err(TableError::ProbabilityTooLarge);
        }
        if i > 0 {
            let q = &pts[i - 1];
            let ok = match peril {
                Peril::Drought => p.level > q.level,
                Peril::Flood => p.level < q.level,
            };
            if !ok {
                return Err(TableError::LevelsNotMonotone);
            }
            if p.p_ppm < q.p_ppm {
                return Err(TableError::ProbabilityNotMonotone);
            }
        }
    }
    Ok(())
}

#[inline]
fn div_ceil(a: u128, b: u128) -> u128 {
    // b is never zero at call sites
    a / b + if a % b == 0 { 0 } else { 1 }
}

/// Linear interpolation of (p, se) at `level`, rounded up (conservative: the
/// secant of a convex tail lies above the curve).
pub fn interpolate(peril: Peril, pts: &[Point], level: u32) -> Result<(u128, u128), PriceError> {
    if pts.len() < 2 {
        return Err(PriceError::EmptyTable);
    }
    let first = pts[0].level;
    let last = pts[pts.len() - 1].level;
    let inside = match peril {
        Peril::Drought => level >= first && level <= last,
        Peril::Flood => level <= first && level >= last,
    };
    if !inside {
        return Err(PriceError::OutOfRange);
    }
    for w in pts.windows(2) {
        let (a, b) = (w[0], w[1]);
        let within = match peril {
            Peril::Drought => level >= a.level && level <= b.level,
            Peril::Flood => level <= a.level && level >= b.level,
        };
        if !within {
            continue;
        }
        let span = (a.level as i64 - b.level as i64).unsigned_abs() as u128;
        let off = (level as i64 - a.level as i64).unsigned_abs() as u128;
        let lerp = |x: u32, y: u32| -> u128 {
            if y >= x {
                x as u128 + div_ceil((y - x) as u128 * off, span)
            } else {
                // decreasing: round the subtracted part down so the result rounds up
                x as u128 - ((x - y) as u128 * off) / span
            }
        };
        return Ok((lerp(a.p_ppm, b.p_ppm), lerp(a.se_ppm, b.se_ppm)));
    }
    Err(PriceError::OutOfRange)
}

/// All-in rate in ppm of payout for a given (p, se).
pub fn rate_ppm(p_ppm: u128, se_ppm: u128, params: &Params) -> Result<u128, PriceError> {
    let margin = div_ceil(se_ppm * params.margin_k_bps as u128, BPS).max(params.floor_ppm as u128);
    let raw = p_ppm.checked_add(margin).ok_or(PriceError::Overflow)?;
    let loaded = raw
        .checked_mul(BPS + params.loading_bps as u128)
        .ok_or(PriceError::Overflow)?;
    let rate = div_ceil(loaded, BPS);
    if rate > params.max_rate_ppm as u128 {
        return Err(PriceError::RateTooHigh);
    }
    Ok(rate)
}

/// premium = ceil(payout * rate / 1e6)
pub fn premium_for(payout: u128, rate_ppm: u128) -> Result<u128, PriceError> {
    let prod = payout.checked_mul(rate_ppm).ok_or(PriceError::Overflow)?;
    Ok(div_ceil(prod, PPM))
}

pub fn quote(peril: Peril, pts: &[Point], level: u32, payout: u128, params: &Params) -> Result<Quote, PriceError> {
    if payout == 0 {
        return Err(PriceError::ZeroPayout);
    }
    let (p, se) = interpolate(peril, pts, level)?;
    let rate = rate_ppm(p, se, params)?;
    let premium = premium_for(payout, rate)?;
    Ok(Quote {
        premium,
        p_ppm: p,
        se_ppm: se,
        rate_ppm: rate,
    })
}

/// Helper for callers that hold points as three parallel arrays.
pub fn zip_points(levels: &[u32], p: &[u32], se: &[u32]) -> Option<Vec<Point>> {
    if levels.len() != p.len() || p.len() != se.len() {
        return None;
    }
    Some(
        levels
            .iter()
            .zip(p)
            .zip(se)
            .map(|((&level, &p_ppm), &se_ppm)| Point { level, p_ppm, se_ppm })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drought_table() -> Vec<Point> {
        vec![
            Point { level: 100, p_ppm: 5_000, se_ppm: 2_000 },
            Point { level: 200, p_ppm: 20_000, se_ppm: 6_000 },
            Point { level: 300, p_ppm: 100_000, se_ppm: 30_000 },
        ]
    }

    fn flood_table() -> Vec<Point> {
        vec![
            Point { level: 200, p_ppm: 5_000, se_ppm: 2_000 },
            Point { level: 150, p_ppm: 20_000, se_ppm: 6_000 },
            Point { level: 100, p_ppm: 100_000, se_ppm: 30_000 },
        ]
    }

    const PARAMS: Params = Params { margin_k_bps: 15_000, floor_ppm: 2_000, loading_bps: 2_500, max_rate_ppm: 700_000 };

    #[test]
    fn interpolation_hits_grid_points_exactly() {
        for t in [drought_table(), flood_table()] {
            let peril = if t[0].level < t[1].level { Peril::Drought } else { Peril::Flood };
            for p in &t {
                assert_eq!(interpolate(peril, &t, p.level), Ok((p.p_ppm as u128, p.se_ppm as u128)));
            }
        }
    }

    #[test]
    fn interpolation_midpoint_and_direction() {
        // drought: between level 100 (5_000) and 200 (20_000), at 150 -> 12_500
        assert_eq!(interpolate(Peril::Drought, &drought_table(), 150), Ok((12_500, 4_000)));
        // flood: between level 200 (5_000) and 150 (20_000), at 175 -> 12_500
        assert_eq!(interpolate(Peril::Flood, &flood_table(), 175), Ok((12_500, 4_000)));
        // probability rises as the drought trigger rises and as the flood trigger falls
        let a = interpolate(Peril::Drought, &drought_table(), 120).unwrap().0;
        let b = interpolate(Peril::Drought, &drought_table(), 180).unwrap().0;
        assert!(b > a);
        let a = interpolate(Peril::Flood, &flood_table(), 190).unwrap().0;
        let b = interpolate(Peril::Flood, &flood_table(), 120).unwrap().0;
        assert!(b > a);
    }

    #[test]
    fn interpolation_rounds_up() {
        // p goes 5_000 -> 5_001 over 3 mm; at 1 mm in, exact = 5_000.33 -> must round up to 5_001
        let t = vec![
            Point { level: 100, p_ppm: 5_000, se_ppm: 100 },
            Point { level: 103, p_ppm: 5_001, se_ppm: 100 },
        ];
        assert_eq!(interpolate(Peril::Drought, &t, 101), Ok((5_001, 100)));
        // se decreasing: 100 -> 97 over 3 mm; at 1 mm in, exact 99 -> 99 (no fractional part)
        let t = vec![
            Point { level: 100, p_ppm: 5_000, se_ppm: 100 },
            Point { level: 103, p_ppm: 6_000, se_ppm: 97 },
        ];
        assert_eq!(interpolate(Peril::Drought, &t, 101).unwrap().1, 99);
        // se decreasing 100 -> 98 over 3: at 1 in exact 99.33 -> rounds up to 100
        let t = vec![
            Point { level: 100, p_ppm: 5_000, se_ppm: 100 },
            Point { level: 103, p_ppm: 6_000, se_ppm: 98 },
        ];
        assert_eq!(interpolate(Peril::Drought, &t, 101).unwrap().1, 100);
    }

    #[test]
    fn out_of_range_is_rejected() {
        assert_eq!(interpolate(Peril::Drought, &drought_table(), 99), Err(PriceError::OutOfRange));
        assert_eq!(interpolate(Peril::Drought, &drought_table(), 301), Err(PriceError::OutOfRange));
        assert_eq!(interpolate(Peril::Flood, &flood_table(), 201), Err(PriceError::OutOfRange));
        assert_eq!(interpolate(Peril::Flood, &flood_table(), 99), Err(PriceError::OutOfRange));
        assert_eq!(interpolate(Peril::Drought, &[], 100), Err(PriceError::EmptyTable));
    }

    #[test]
    fn known_quote() {
        // p=12_500, se=4_000 at level 150.
        // margin = max(ceil(4_000*1.5)=6_000, 2_000) = 6_000; raw = 18_500
        // rate = ceil(18_500 * 1.25) = 23_125 ppm; premium on 1_000 USD (6dp) = 23_125_000
        let q = quote(Peril::Drought, &drought_table(), 150, 1_000_000_000, &PARAMS).unwrap();
        assert_eq!(q.p_ppm, 12_500);
        assert_eq!(q.se_ppm, 4_000);
        assert_eq!(q.rate_ppm, 23_125);
        assert_eq!(q.premium, 23_125_000);
    }

    #[test]
    fn floor_applies_when_se_is_tiny() {
        // se = 0 -> margin falls back to floor (2_000): raw = p + 2_000
        let t = vec![
            Point { level: 100, p_ppm: 10_000, se_ppm: 0 },
            Point { level: 200, p_ppm: 20_000, se_ppm: 0 },
        ];
        let q = quote(Peril::Drought, &t, 100, 1_000_000, &PARAMS).unwrap();
        assert_eq!(q.rate_ppm, 15_000); // (10_000 + 2_000) * 1.25
    }

    #[test]
    fn premium_never_below_fair_value_and_rounds_up() {
        assert_eq!(premium_for(1, 1), Ok(1));
        assert_eq!(premium_for(999_999, 1), Ok(1));
        assert_eq!(premium_for(1_000_000, 1), Ok(1));
        assert_eq!(premium_for(1_000_001, 1), Ok(2));
        assert_eq!(premium_for(0, 500), Ok(0));
        assert_eq!(premium_for(u128::MAX, 2), Err(PriceError::Overflow));
    }

    #[test]
    fn rejects_zero_payout_and_expensive_rates() {
        assert_eq!(quote(Peril::Drought, &drought_table(), 150, 0, &PARAMS), Err(PriceError::ZeroPayout));
        // p = 100_000 + se 30_000*1.5=45_000 -> 145_000*1.25 = 181_250 < 700_000: fine
        assert!(quote(Peril::Drought, &drought_table(), 300, 1_000, &PARAMS).is_ok());
        let tight = Params { max_rate_ppm: 100_000, ..PARAMS };
        assert_eq!(quote(Peril::Drought, &drought_table(), 300, 1_000, &tight), Err(PriceError::RateTooHigh));
    }

    #[test]
    fn premium_is_monotone_across_the_whole_table() {
        // sweeping the trigger toward the easier-to-hit end must never lower the premium
        let t = drought_table();
        let mut last = 0u128;
        for level in 100..=300u32 {
            let q = quote(Peril::Drought, &t, level, 10_000_000_000, &PARAMS).unwrap();
            assert!(q.premium >= last, "level {level}");
            // and never below the fitted fair value
            assert!(q.premium >= 10_000_000_000u128 * q.p_ppm / PPM);
            last = q.premium;
        }
        let t = flood_table();
        let mut last = 0u128;
        for level in (100..=200u32).rev() {
            let q = quote(Peril::Flood, &t, level, 10_000_000_000, &PARAMS).unwrap();
            assert!(q.premium >= last, "level {level}");
            last = q.premium;
        }
    }

    #[test]
    fn table_validation() {
        let ok = drought_table();
        assert_eq!(validate_table(Peril::Drought, &ok), Ok(()));
        assert_eq!(validate_table(Peril::Flood, &flood_table()), Ok(()));
        assert_eq!(validate_table(Peril::Drought, &ok[..1]), Err(TableError::TooFewPoints));
        // flood levels fed to a drought table are descending
        assert_eq!(validate_table(Peril::Drought, &flood_table()), Err(TableError::LevelsNotMonotone));
        assert_eq!(validate_table(Peril::Flood, &drought_table()), Err(TableError::LevelsNotMonotone));
        let mut bad = ok.clone();
        bad[2].p_ppm = 1_000; // probability falls
        assert_eq!(validate_table(Peril::Drought, &bad), Err(TableError::ProbabilityNotMonotone));
        let mut bad = ok.clone();
        bad[0].p_ppm = 0;
        assert_eq!(validate_table(Peril::Drought, &bad), Err(TableError::ZeroProbability));
        let mut bad = ok.clone();
        bad[2].p_ppm = 1_000_001;
        assert_eq!(validate_table(Peril::Drought, &bad), Err(TableError::ProbabilityTooLarge));
        let mut dup = ok.clone();
        dup[1].level = dup[0].level;
        assert_eq!(validate_table(Peril::Drought, &dup), Err(TableError::LevelsNotMonotone));
        let many: Vec<Point> = (0..33).map(|i| Point { level: 10 + i, p_ppm: 1_000 + i, se_ppm: 1 }).collect();
        assert_eq!(validate_table(Peril::Drought, &many), Err(TableError::TooManyPoints));
    }

    #[test]
    fn params_validation() {
        assert!(PARAMS.is_valid());
        assert!(!Params { max_rate_ppm: 1_000_000, ..PARAMS }.is_valid());
        assert!(!Params { max_rate_ppm: 0, ..PARAMS }.is_valid());
        assert!(!Params { loading_bps: 100_001, ..PARAMS }.is_valid());
    }

    #[test]
    fn zip_requires_equal_lengths() {
        assert!(zip_points(&[1, 2], &[1, 2], &[1]).is_none());
        assert_eq!(zip_points(&[1], &[2], &[3]).unwrap()[0], Point { level: 1, p_ppm: 2, se_ppm: 3 });
    }
}
