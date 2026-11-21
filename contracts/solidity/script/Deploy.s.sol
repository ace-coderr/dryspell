// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {DryspellEngineSol} from "../src/DryspellEngineSol.sol";
import {UnderwriterVault} from "../src/UnderwriterVault.sol";
import {WeatherOracle} from "../src/WeatherOracle.sol";
import {PolicyBook} from "../src/PolicyBook.sol";
import {IDryspellEngine} from "../src/interfaces/IDryspellEngine.sol";
import {IWeatherOracle} from "../src/interfaces/IWeatherOracle.sol";

/// @notice Deploys the whole system and loads the real exceedance tables, season windows,
///         calibration factors and exposure caps from data/generated/exceedance.json.
///
///   forge script script/Deploy.s.sol --rpc-url $ARBITRUM_SEPOLIA_RPC            # dry run: prints the gas estimate
///   forge script script/Deploy.s.sol --rpc-url $ARBITRUM_SEPOLIA_RPC --broadcast # real deployment
///
/// Env: DEPLOYER_PRIVATE_KEY (testnet only), optional ENGINE_ADDRESS to wire in an already deployed
/// Stylus engine instead of deploying the Solidity fallback.
///
/// ids: locSeasonId = locationIndex * 10 + seasonIndex;  tableId = locSeasonId * 2 + peril (0 drought, 1 flood)
contract Deploy is Script {
    // ---- test-network parameters (shorter than a production deployment would use)
    uint256 constant DATA_LAG = 6 days; // real: reanalysis and satellite blends lag about 5 days
    uint256 constant DISPUTE_WINDOW = 1 hours; // production: 24h
    uint256 constant RESOLVER_TIMEOUT = 6 hours; // production: 3 days
    uint256 constant REPORT_WINDOW = 30 days;
    uint256 constant MIN_BOND = 100e6;
    uint256 constant BOND_BPS = 1_000;
    uint256 constant REWARD_PER_ROUND = 5e6;
    uint256 constant VAULT_MIN_HOLD = 1 hours; // production: 1 day
    uint256 constant LEAD_TIME = 14 days;
    uint256 constant MAX_HORIZON = 400 days;
    uint256 constant MIN_PAYOUT = 10e6;
    uint256 constant ORACLE_FEE_BPS = 200;
    uint256 constant DROUGHT_CAP_BPS = 2_500; // per region
    uint256 constant FLOOD_CAP_BPS = 1_500; // per region

    string internal json;

    TestUSD public token;
    IDryspellEngine public engine;
    UnderwriterVault public vault;
    WeatherOracle public oracle;
    PolicyBook public book;

    function run() external {
        json = vm.readFile("../../data/generated/exceedance.json");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(pk);

        vm.startBroadcast(pk);
        token = new TestUSD();
        address existing = vm.envOr("ENGINE_ADDRESS", address(0));
        if (existing == address(0)) {
            engine = IDryspellEngine(address(new DryspellEngineSol(deployer)));
        } else {
            engine = IDryspellEngine(existing);
        }
        vault = new UnderwriterVault(IERC20(address(token)), engine, VAULT_MIN_HOLD, deployer);
        oracle = new WeatherOracle(
            IERC20(address(token)),
            deployer,
            deployer, // named resolver: a single trusted address in v1 (see README)
            DATA_LAG,
            DISPUTE_WINDOW,
            RESOLVER_TIMEOUT,
            REPORT_WINDOW,
            MIN_BOND,
            BOND_BPS,
            REWARD_PER_ROUND
        );
        book = new PolicyBook(
            IERC20(address(token)), engine, vault, IWeatherOracle(address(oracle)), deployer, LEAD_TIME, MAX_HORIZON, MIN_PAYOUT, ORACLE_FEE_BPS
        );

        // wiring (each link is set once or owner-controlled)
        engine.setBook(address(book));
        engine.setVault(address(vault));
        vault.setBook(address(book));
        oracle.setBook(address(book));
        for (uint8 region; region < 4; ++region) {
            engine.setCap(region, 0, DROUGHT_CAP_BPS);
            engine.setCap(region, 1, FLOOD_CAP_BPS);
        }

        _loadLocations();
        vm.stopBroadcast();

        console.log("engineKind     :", engine.engineKind());
        console.log("TestUSD        :", address(token));
        console.log("Engine         :", address(engine));
        console.log("UnderwriterVault:", address(vault));
        console.log("WeatherOracle  :", address(oracle));
        console.log("PolicyBook     :", address(book));
        console.log("owner/resolver :", deployer);
    }

    function _uints(string memory path) internal view returns (uint256[] memory) {
        return abi.decode(vm.parseJson(json, path), (uint256[]));
    }

    function _loadLocations() internal {
        for (uint256 i; vm.keyExistsJson(json, string.concat(".locations[", vm.toString(i), "]")); ++i) {
            string memory lp = string.concat(".locations[", vm.toString(i), "]");
            uint8 region = _region(vm.parseJsonString(json, string.concat(lp, ".region")));
            for (uint256 j; vm.keyExistsJson(json, string.concat(lp, ".seasons[", vm.toString(j), "]")); ++j) {
                _loadSeason(string.concat(lp, ".seasons[", vm.toString(j), "]"), i * 10 + j, region);
            }
        }
    }

    function _loadSeason(string memory sp, uint256 locSeasonId, uint8 region) internal {
        (uint8 sm, uint8 sd) = _md(vm.parseJsonString(json, string.concat(sp, ".start")));
        (uint8 em, uint8 ed) = _md(vm.parseJsonString(json, string.concat(sp, ".end")));
        oracle.defineSeason(locSeasonId, sm, sd, em, ed);
        for (uint8 k; k < 2; ++k) {
            string memory pp = string.concat(sp, ".perils[", vm.toString(uint256(k)), "]");
            oracle.defineCalibration(
                locSeasonId,
                k,
                uint32(vm.parseJsonUint(json, string.concat(pp, ".calibration_era5_ppm"))),
                uint32(vm.parseJsonUint(json, string.concat(pp, ".calibration_power_ppm")))
            );
            // only perils whose two sources agree well enough are offered (see data/README.md)
            if (vm.parseJsonBool(json, string.concat(pp, ".offered"))) {
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

    function _u32(uint256[] memory a) internal pure returns (uint32[] memory r) {
        r = new uint32[](a.length);
        for (uint256 i; i < a.length; ++i) {
            r[i] = uint32(a[i]);
        }
    }

    function _region(string memory name) internal pure returns (uint8) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("West Africa")) return 0;
        if (h == keccak256("East Africa")) return 1;
        if (h == keccak256("South Asia")) return 2;
        if (h == keccak256("Southeast Asia")) return 3;
        revert("unknown region");
    }

    /// @dev "06-01" -> (6, 1)
    function _md(string memory s) internal pure returns (uint8, uint8) {
        bytes memory b = bytes(s);
        require(b.length == 5 && b[2] == "-", "bad MM-DD");
        return (uint8((uint8(b[0]) - 48) * 10 + (uint8(b[1]) - 48)), uint8((uint8(b[3]) - 48) * 10 + (uint8(b[4]) - 48)));
    }
}
