// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Deploy} from "./Deploy.s.sol";
import {DryspellEngineSol} from "../src/DryspellEngineSol.sol";
import {WeatherOracle} from "../src/WeatherOracle.sol";
import {IDryspellEngine} from "../src/interfaces/IDryspellEngine.sol";

/// @notice Finishes an interrupted deployment. Everything is checked first, so it only sends what is missing:
///   ENGINE_ADDRESS and ORACLE_ADDRESS must point at the already deployed engine and oracle.
///   forge script script/Resume.s.sol --rpc-url $ARBITRUM_SEPOLIA_RPC --broadcast
contract Resume is Deploy {
    function run() external override {
        json = vm.readFile("../../data/generated/exceedance.json");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        engine = IDryspellEngine(vm.envAddress("ENGINE_ADDRESS"));
        oracle = WeatherOracle(vm.envAddress("ORACLE_ADDRESS"));
        vm.startBroadcast(pk);
        for (uint8 region; region < 4; ++region) {
            if (engine.capBpsOf(region, 0) != DROUGHT_CAP_BPS) engine.setCap(region, 0, DROUGHT_CAP_BPS);
            if (engine.capBpsOf(region, 1) != FLOOD_CAP_BPS) engine.setCap(region, 1, FLOOD_CAP_BPS);
        }
        _loadLocations();
        vm.stopBroadcast();
    }

    /// @dev same as Deploy._loadSeason but skips anything already on chain
    function _loadSeason(string memory sp, uint256 locSeasonId, uint8 region) internal override {
        if (!oracle.seasonExists(locSeasonId)) {
            (uint8 sm, uint8 sd) = _md(vm.parseJsonString(json, string.concat(sp, ".start")));
            (uint8 em, uint8 ed) = _md(vm.parseJsonString(json, string.concat(sp, ".end")));
            oracle.defineSeason(locSeasonId, sm, sd, em, ed);
        }
        for (uint8 k; k < 2; ++k) {
            string memory pp = string.concat(sp, ".perils[", vm.toString(uint256(k)), "]");
            (bool set,,) = oracle.calibration(locSeasonId, k);
            if (!set) {
                oracle.defineCalibration(
                    locSeasonId,
                    k,
                    uint32(vm.parseJsonUint(json, string.concat(pp, ".calibration_era5_ppm"))),
                    uint32(vm.parseJsonUint(json, string.concat(pp, ".calibration_power_ppm")))
                );
            }
            (bool exists,,,) = engine.tableInfo(locSeasonId * 2 + k);
            if (!exists && vm.parseJsonBool(json, string.concat(pp, ".offered"))) {
                engine.loadTable(
                    locSeasonId * 2 + k,
                    region,
                    k,
                    _u32(_uints(string.concat(pp, ".table[*].level_mm"))),
                    _u32(_uints(string.concat(pp, ".table[*].p_ppm"))),
                    _u32(_uints(string.concat(pp, ".table[*].se_ppm")))
                );
            }
        }
    }
}
