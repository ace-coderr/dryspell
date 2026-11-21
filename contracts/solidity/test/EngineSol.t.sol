// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {DryspellEngineSol} from "../src/DryspellEngineSol.sol";
import {IDryspellEngine} from "../src/interfaces/IDryspellEngine.sol";

/// @dev mirrors the Rust contract tests in contracts/stylus/src/lib.rs
contract EngineSolTest is Base {
    function _arr(uint32 a, uint32 b, uint32 c) internal pure returns (uint32[] memory r) {
        r = new uint32[](3);
        r[0] = a;
        r[1] = b;
        r[2] = c;
    }

    function _arr2(uint32 a, uint32 b) internal pure returns (uint32[] memory r) {
        r = new uint32[](2);
        r[0] = a;
        r[1] = b;
    }

    function test_identity_and_defaults() public {
        assertEq(engine.engineKind(), "solidity-fallback");
        assertEq(engine.owner(), owner);
        (uint256 k, uint256 floorPpm, uint256 loading, uint256 maxRate, uint256 util) = engine.params();
        assertEq(k, 15_000);
        assertEq(floorPpm, 2_000);
        assertEq(loading, 2_500);
        assertEq(maxRate, 700_000);
        assertEq(util, 8_000);
        vm.expectRevert(IDryspellEngine.ZeroAddress.selector);
        new DryspellEngineSol(address(0));
    }

    function test_only_owner_administers() public {
        vm.startPrank(stranger);
        vm.expectRevert(IDryspellEngine.NotOwner.selector);
        engine.setBook(stranger);
        vm.expectRevert(IDryspellEngine.NotOwner.selector);
        engine.setVault(stranger);
        vm.expectRevert(IDryspellEngine.NotOwner.selector);
        engine.setCap(0, 0, 1);
        vm.expectRevert(IDryspellEngine.NotOwner.selector);
        engine.setPricingParams(1, 1, 1, 1, 1);
        vm.expectRevert(IDryspellEngine.NotOwner.selector);
        engine.setTableEnabled(T_DRY, false);
        vm.expectRevert(IDryspellEngine.NotOwner.selector);
        engine.transferOwnership(stranger);
        vm.expectRevert(IDryspellEngine.NotOwner.selector);
        engine.loadTable(9, 0, 0, _arr2(1, 2), _arr2(1, 2), _arr2(0, 0));
        vm.stopPrank();
        // the book cannot administer either
        vm.prank(address(book));
        vm.expectRevert(IDryspellEngine.NotOwner.selector);
        engine.setBook(stranger);
    }

    function test_only_the_book_reserves_and_releases() public {
        for (uint256 i; i < 3; ++i) {
            address who = i == 0 ? owner : i == 1 ? stranger : address(vault);
            vm.startPrank(who);
            vm.expectRevert(IDryspellEngine.NotBook.selector);
            engine.reserve(T_DRY, 1 * USD);
            vm.expectRevert(IDryspellEngine.NotBook.selector);
            engine.release(T_DRY, 1 * USD);
            vm.stopPrank();
        }
    }

    function test_quote_rejections() public {
        vm.expectRevert(IDryspellEngine.UnknownTable.selector);
        engine.quote(99, 150, 1000 * USD);
        vm.expectRevert(IDryspellEngine.OutOfRange.selector);
        engine.quote(T_DRY, 99, 1000 * USD);
        vm.expectRevert(IDryspellEngine.OutOfRange.selector);
        engine.quote(T_DRY, 301, 1000 * USD);
        vm.expectRevert(IDryspellEngine.OutOfRange.selector);
        engine.quote(T_DRY, type(uint256).max, 1000 * USD);
        vm.expectRevert(IDryspellEngine.ZeroPayout.selector);
        engine.quote(T_DRY, 150, 0);
        vm.expectRevert(IDryspellEngine.AmountTooLarge.selector);
        engine.quote(T_DRY, 150, type(uint256).max);
        vm.prank(owner);
        engine.setTableEnabled(T_DRY, false);
        vm.expectRevert(IDryspellEngine.TableDisabled.selector);
        engine.quote(T_DRY, 150, 1000 * USD);
        vm.startPrank(owner);
        engine.setTableEnabled(T_DRY, true);
        engine.setPricingParams(15_000, 2_000, 2_500, 100_000, 8_000);
        vm.stopPrank();
        vm.expectRevert(IDryspellEngine.RateTooHigh.selector);
        engine.quote(T_DRY, 300, 1000 * USD);
    }

    function test_parameter_validation() public {
        vm.startPrank(owner);
        engine.setPricingParams(15_000, 2_000, 2_500, 700_000, 8_000);
        vm.expectRevert(IDryspellEngine.BadParams.selector);
        engine.setPricingParams(15_000, 2_000, 2_500, 1_000_000, 8_000); // rate cap must stay below 100%
        vm.expectRevert(IDryspellEngine.BadParams.selector);
        engine.setPricingParams(15_000, 2_000, 2_500, 0, 8_000);
        vm.expectRevert(IDryspellEngine.BadParams.selector);
        engine.setPricingParams(15_000, 2_000, 2_500, 700_000, 0);
        vm.expectRevert(IDryspellEngine.BadParams.selector);
        engine.setPricingParams(15_000, 2_000, 2_500, 700_000, 10_001);
        vm.expectRevert(IDryspellEngine.BadParams.selector);
        engine.setPricingParams(15_000, 2_000, 100_001, 700_000, 8_000);
        vm.expectRevert(IDryspellEngine.BadParams.selector);
        engine.setPricingParams(uint256(type(uint32).max) + 1, 2_000, 2_500, 700_000, 8_000);
        vm.expectRevert(IDryspellEngine.BadParams.selector);
        engine.setCap(0, 0, 10_001);
        vm.expectRevert(IDryspellEngine.BadParams.selector);
        engine.setCap(0, 7, 100);
        vm.stopPrank();
    }

    function test_table_validation_codes() public {
        vm.startPrank(owner);
        _expectBad(1);
        engine.loadTable(T_DRY, 0, 0, new uint32[](1), new uint32[](1), new uint32[](1));
        _expectBad(2);
        engine.loadTable(T_DRY, 0, 9, _arr2(1, 2), _arr2(1, 2), _arr2(0, 0));
        _expectBad(3);
        engine.loadTable(T_DRY, 0, 0, _arr2(200, 100), _arr2(1, 2), _arr2(0, 0));
        _expectBad(4);
        engine.loadTable(T_DRY, 0, 0, _arr2(100, 200), _arr2(2, 1), _arr2(0, 0));
        _expectBad(5);
        engine.loadTable(T_DRY, 0, 0, _arr2(100, 200), _arr2(1, 2_000_000), _arr2(0, 0));
        _expectBad(6);
        engine.loadTable(T_DRY, 0, 0, _arr2(100, 200), _arr2(0, 5), _arr2(0, 0));
        _expectBad(8);
        engine.loadTable(T_DRY, 0, 0, _arr2(100, 200), _arr2(1, 2), new uint32[](1));
        // region or peril cannot change once a table exists
        _expectBad(9);
        engine.loadTable(T_DRY, 3, 0, _arr2(100, 200), _arr2(1, 2), _arr2(0, 0));
        _expectBad(9);
        engine.loadTable(T_DRY, 0, 1, _arr2(200, 100), _arr2(1, 2), _arr2(0, 0));
        // 33 points is too many
        uint32[] memory l = new uint32[](33);
        uint32[] memory p = new uint32[](33);
        for (uint32 i; i < 33; ++i) {
            l[i] = 10 + i;
            p[i] = 1_000 + i;
        }
        _expectBad(7);
        engine.loadTable(T_DRY, 0, 0, l, p, new uint32[](33));
        // a failed reload left the old table intact
        (uint32[] memory lv,,) = engine.tablePoints(T_DRY);
        assertEq(lv.length, 3);
        // a valid reload replaces points and keeps the enabled flag
        engine.setTableEnabled(T_DRY, false);
        engine.loadTable(T_DRY, 0, 0, _arr2(50, 90), _arr2(1_000, 3_000), _arr2(100, 100));
        (lv,,) = engine.tablePoints(T_DRY);
        assertEq(lv.length, 2);
        (bool exists, bool enabled,,) = engine.tableInfo(T_DRY);
        assertTrue(exists);
        assertFalse(enabled);
        vm.stopPrank();
        vm.expectRevert(IDryspellEngine.UnknownTable.selector);
        engine.tablePoints(1234);
        (exists,,,) = engine.tableInfo(1234);
        assertFalse(exists);
    }

    function _expectBad(uint8 code) internal {
        vm.expectRevert(abi.encodeWithSelector(IDryspellEngine.BadTable.selector, code));
    }

    function test_exposure_caps_and_releases_through_the_book() public {
        vm.startPrank(address(book));
        engine.reserve(T_DRY, 250_000 * USD); // exactly 25% of 1,000,000
        assertEq(engine.exposureOf(0, 0), 250_000 * USD);
        vm.expectRevert(abi.encodeWithSelector(IDryspellEngine.CapBreached.selector, uint8(1)));
        engine.reserve(T_DRY, 1);
        assertEq(engine.totalExposure(), 250_000 * USD, "failed reserve left no trace");
        vm.expectRevert(IDryspellEngine.ReleaseTooLarge.selector);
        engine.release(T_FLOOD, 1); // other peril holds nothing
        vm.expectRevert(IDryspellEngine.ZeroPayout.selector);
        engine.release(T_DRY, 0);
        engine.release(T_DRY, 250_000 * USD);
        assertEq(engine.totalExposure(), 0);
        vm.stopPrank();
    }

    function test_capital_is_read_from_the_vault_each_time() public {
        vm.prank(address(book));
        engine.reserve(T_DRY, 100_000 * USD);
        // underwriters leave: capital halves, so the 25% cap is now 125,000
        vm.warp(block.timestamp + 1 days);
        vm.prank(uw);
        vault.withdraw(500_000 * USD, uw, uw);
        assertApproxEqAbs(engine.headroom(T_DRY), 25_000 * USD, 2);
    }

    function test_no_cap_and_no_capital_block_cover() public {
        vm.startPrank(owner);
        engine.loadTable(7, 2, 0, _arr2(10, 20), _arr2(1_000, 2_000), _arr2(100, 100)); // region 2 has no cap
        vm.stopPrank();
        vm.prank(address(book));
        vm.expectRevert(IDryspellEngine.NoCap.selector);
        engine.reserve(7, 1 * USD);

        // engine with no vault configured
        DryspellEngineSol lone = new DryspellEngineSol(owner);
        vm.startPrank(owner);
        lone.setBook(address(this));
        lone.loadTable(1, 0, 0, _arr2(10, 20), _arr2(1_000, 2_000), _arr2(100, 100));
        vm.stopPrank();
        vm.expectRevert(IDryspellEngine.NoCapital.selector);
        lone.reserve(1, 1 * USD);

        // a vault that reverts, and one that reports an absurd balance
        address reverting = address(new RevertingVault());
        address huge = address(new HugeVault());
        vm.prank(owner);
        lone.setVault(reverting);
        vm.expectRevert(IDryspellEngine.VaultCallFailed.selector);
        lone.reserve(1, 1 * USD);
        vm.prank(owner);
        lone.setVault(huge);
        vm.expectRevert(IDryspellEngine.AmountTooLarge.selector);
        lone.reserve(1, 1 * USD);
    }

    function test_two_step_ownership() public {
        vm.prank(stranger);
        vm.expectRevert(IDryspellEngine.NotPendingOwner.selector);
        engine.acceptOwnership();
        vm.startPrank(owner);
        vm.expectRevert(IDryspellEngine.ZeroAddress.selector);
        engine.transferOwnership(address(0));
        engine.transferOwnership(stranger);
        vm.stopPrank();
        assertEq(engine.owner(), owner);
        vm.prank(buyer);
        vm.expectRevert(IDryspellEngine.NotPendingOwner.selector);
        engine.acceptOwnership();
        vm.prank(stranger);
        engine.acceptOwnership();
        assertEq(engine.owner(), stranger);
        vm.prank(owner);
        vm.expectRevert(IDryspellEngine.NotOwner.selector);
        engine.setBook(owner);
        vm.prank(stranger);
        vm.expectRevert(IDryspellEngine.NotPendingOwner.selector);
        engine.acceptOwnership();
    }
}

contract RevertingVault {
    function totalAssets() external pure returns (uint256) {
        revert("nope");
    }
}

contract HugeVault {
    function totalAssets() external pure returns (uint256) {
        return type(uint256).max;
    }
}
