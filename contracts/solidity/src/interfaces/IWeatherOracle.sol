// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

interface IWeatherOracle {
    enum State {
        None, // nothing reported yet
        Proposed, // a bonded reporter posted readings; dispute window open
        Disputed, // challenged; waiting for the named resolver
        Final, // settlement values are fixed
        Void // no usable result; policies are refunded
    }

    function roundState(uint256 roundId) external view returns (State);
    function isReplay(uint256 roundId) external view returns (bool);
    function seasonExists(uint256 locSeasonId) external view returns (bool);
    function seasonWindow(uint256 locSeasonId, uint256 year) external view returns (uint256 start, uint256 end);
    /// @return totalX2 calibrated median of the two season totals, in units of 0.05 mm
    /// @return max3X2 calibrated median of the two max 3-day rainfalls, in units of 0.05 mm
    function finalValues(uint256 roundId) external view returns (uint256 totalX2, uint256 max3X2);
    /// @return era5X ERA5 reading after calibration, in 0.1 mm (peril 0: season total, 1: max 3-day)
    /// @return powerX NASA POWER reading after calibration, in 0.1 mm
    function calibratedSources(uint256 roundId, uint8 peril) external view returns (uint256 era5X, uint256 powerX);
    /// @notice largest allowed relative spread between the two calibrated readings, in bps of their mean
    function maxSpreadBps() external view returns (uint256);
    /// @notice the named resolver address
    function resolver() external view returns (address);
    function fundRewards(uint256 amount) external;
    /// @notice sets a round to Void if nobody reported in time; no-op if not applicable
    function voidUnreported(uint256 roundId) external;
}
