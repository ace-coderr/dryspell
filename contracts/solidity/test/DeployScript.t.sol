// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";

/// @dev runs the real deployment script on a local chain and checks the on-chain result against the JSON
contract DeployScriptTest is Test {
    Deploy d;
    string json;

    function _uints(string memory path) internal view returns (uint256[] memory) {
        return abi.decode(vm.parseJson(json, path), (uint256[]));
    }

    function _checkSeason(string memory sp, uint256 locSeasonId) internal view returns (uint256 offered) {
        assertTrue(d.oracle().seasonExists(locSeasonId), "season defined");
        for (uint256 k; k < 2; ++k) {
            string memory pp = string.concat(sp, ".perils[", vm.toString(k), "]");
            (bool exists, bool enabled,,) = d.engine().tableInfo(locSeasonId * 2 + k);
            bool isOffered = vm.parseJsonBool(json, string.concat(pp, ".offered"));
            assertEq(exists, isOffered, "only offered perils have a table");
            if (isOffered) {
                assertTrue(enabled);
                ++offered;
                (uint32[] memory lv,,) = d.engine().tablePoints(locSeasonId * 2 + k);
                assertEq(lv.length, _uints(string.concat(pp, ".table[*].level_mm")).length);
            }
        }
    }

    function test_deployment_loads_every_offered_table_and_season() public {
        vm.setEnv("DEPLOYER_PRIVATE_KEY", vm.toString(uint256(keccak256("dryspell-local-test-key"))));
        vm.setEnv("ENGINE_ADDRESS", "0x0000000000000000000000000000000000000000");
        d = new Deploy();
        d.run();
        json = vm.readFile("../../data/generated/exceedance.json");

        uint256 offered;
        uint256 seasons;
        for (uint256 i; vm.keyExistsJson(json, string.concat(".locations[", vm.toString(i), "]")); ++i) {
            string memory lp = string.concat(".locations[", vm.toString(i), "]");
            for (uint256 j; vm.keyExistsJson(json, string.concat(lp, ".seasons[", vm.toString(j), "]")); ++j) {
                offered += _checkSeason(string.concat(lp, ".seasons[", vm.toString(j), "]"), i * 10 + j);
                ++seasons;
            }
        }
        assertEq(seasons, 14);
        assertEq(offered, 16);
        assertEq(d.engine().engineKind(), "solidity-fallback");
        assertEq(d.book().engineKind(), "solidity-fallback");
        // wiring is complete and one-way
        assertEq(d.engine().book(), address(d.book()));
        assertEq(d.engine().vault(), address(d.vault()));
        assertEq(d.vault().book(), address(d.book()));
        assertEq(d.oracle().book(), address(d.book()));
    }
}
