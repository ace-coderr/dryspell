// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice UTC calendar helpers for season windows. Civil-date <-> day-count conversion follows
///         Howard Hinnant's public-domain algorithm.
library SeasonCalendar {
    error BadDate();

    /// @dev days since 1970-01-01 for a proleptic Gregorian date; valid for years 1970..2200
    function daysFromCivil(uint256 y, uint256 m, uint256 d) internal pure returns (uint256) {
        if (y < 1970 || y > 2200 || m < 1 || m > 12 || d < 1 || d > 31) revert BadDate();
        if (m <= 2) y -= 1;
        uint256 era = y / 400;
        uint256 yoe = y - era * 400;
        uint256 mp = (m + 9) % 12; // March = 0
        uint256 doy = (153 * mp + 2) / 5 + d - 1;
        uint256 doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        // era * 146097 + doe - 719468
        return era * 146097 + doe - 719468;
    }

    /// @return start unix time of 00:00 UTC on the first day, end unix time just after the last day
    function window(uint256 year, uint8 sm, uint8 sd, uint8 em, uint8 ed) internal pure returns (uint256 start, uint256 end) {
        bool crosses = (em < sm) || (em == sm && ed < sd);
        start = daysFromCivil(year, sm, sd) * 1 days;
        end = (daysFromCivil(crosses ? year + 1 : year, em, ed) + 1) * 1 days;
    }
}
