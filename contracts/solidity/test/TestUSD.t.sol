// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestUSD} from "../src/TestUSD.sol";

contract TestUSDTest is Test {
    TestUSD t;
    address a = makeAddr("a");
    address b = makeAddr("b");

    function setUp() public {
        t = new TestUSD();
        vm.warp(1_800_000_000);
    }

    function test_faucet_mints_a_fixed_amount_with_a_cooldown() public {
        vm.prank(a);
        t.faucet();
        assertEq(t.balanceOf(a), 10_000e6);
        vm.prank(a);
        vm.expectRevert(abi.encodeWithSelector(TestUSD.FaucetCooldown.selector, block.timestamp + 1 hours));
        t.faucet();
        vm.warp(block.timestamp + 1 hours);
        vm.prank(a);
        t.faucet();
        assertEq(t.balanceOf(a), 20_000e6);
        // limits are per address
        vm.prank(b);
        t.faucet();
        assertEq(t.balanceOf(b), 10_000e6);
    }

    function test_it_is_clearly_labelled_and_six_decimals() public view {
        assertEq(t.decimals(), 6);
        assertEq(t.symbol(), "tUSD");
        assertGt(bytes(t.name()).length, 20);
    }
}
