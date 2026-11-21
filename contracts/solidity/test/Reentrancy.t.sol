// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {PolicyBook} from "../src/PolicyBook.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @dev a token that calls back into the protocol in the middle of every transfer (like an ERC-777 hook)
contract HookToken is TestUSD {
    address public target;
    bytes[] public calls;
    bool private _inHook;
    bool[] public results;
    bytes4[] public selectors;

    function arm(address target_, bytes[] memory calls_) external {
        target = target_;
        delete calls;
        for (uint256 i; i < calls_.length; ++i) {
            calls.push(calls_[i]);
        }
        delete results;
        delete selectors;
    }

    function disarm() external {
        target = address(0);
    }

    function resultCount() external view returns (uint256) {
        return results.length;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (target != address(0) && !_inHook && from != address(0)) {
            _inHook = true;
            for (uint256 i; i < calls.length; ++i) {
                (bool ok, bytes memory ret) = target.call(calls[i]);
                results.push(ok);
                selectors.push(ret.length >= 4 ? bytes4(ret) : bytes4(0));
            }
            _inHook = false;
        }
    }
}

contract ReentrancyTest is Base {
    HookToken hook;
    uint256 policyId;

    function _deployToken() internal override returns (TestUSD) {
        hook = new HookToken();
        return hook;
    }

    function setUp() public override {
        super.setUp();
        policyId = _buy(buyer, T_DRY, 200, 100 * USD);
    }

    function _assertAllBlocked() internal view {
        assertGt(hook.resultCount(), 0, "hook fired");
        for (uint256 i; i < hook.resultCount(); ++i) {
            assertFalse(hook.results(i), "re-entrant call must fail");
            assertEq(hook.selectors(i), ReentrancyGuard.ReentrancyGuardReentrantCall.selector, "blocked by the guard");
        }
    }

    function test_cannot_reenter_the_book_from_the_premium_transfer() public {
        bytes[] memory c = new bytes[](3);
        c[0] = abi.encodeCall(PolicyBook.settle, (policyId));
        c[1] = abi.encodeCall(PolicyBook.buy, (T_DRY, YEAR, 200, 100 * USD, type(uint256).max));
        c[2] = abi.encodeCall(PolicyBook.refund, (policyId));
        (uint256 premium,,,,) = book.quote(T_DRY, YEAR, 150, 100 * USD);
        _fund(buyer2, premium);
        vm.startPrank(buyer2);
        token.approve(address(book), premium);
        hook.arm(address(book), c);
        book.buy(T_DRY, YEAR, 150, 100 * USD, premium);
        vm.stopPrank();
        _assertAllBlocked();
        assertEq(book.policyCount(), 2, "exactly one new policy");
        assertEq(engine.totalExposure(), 200 * USD);
    }

    function test_cannot_reenter_settlement_from_the_payout_transfer() public {
        _finalizeUndisputed(1000, 500, 1000, 500); // drought pays
        bytes[] memory c = new bytes[](3);
        c[0] = abi.encodeCall(PolicyBook.settle, (policyId));
        c[1] = abi.encodeCall(PolicyBook.refund, (policyId));
        c[2] = abi.encodeCall(PolicyBook.buy, (T_DRY, YEAR, 200, 100 * USD, type(uint256).max));
        uint256 before = token.balanceOf(buyer);
        hook.arm(address(book), c);
        book.settle(policyId);
        _assertAllBlocked();
        assertEq(token.balanceOf(buyer), before + 100 * USD, "paid exactly once");
        assertEq(engine.totalExposure(), 0);
    }

    function test_cannot_reenter_the_vault_during_withdraw() public {
        vm.warp(block.timestamp + 1 days);
        // the token itself plays the attacker: it holds funds and an allowance, then deposits in the
        // middle of the vault's own payout transfer
        _fund(address(hook), 10 * USD);
        vm.prank(address(hook));
        hook.approve(address(vault), type(uint256).max);
        bytes[] memory c = new bytes[](1);
        c[0] = abi.encodeWithSignature("deposit(uint256,address)", 1 * USD, address(hook));
        hook.arm(address(vault), c);
        vm.prank(uw);
        vault.withdraw(10 * USD, uw, uw);
        _assertAllBlocked();
    }

    function test_cannot_reenter_the_oracle_from_a_bond_transfer() public {
        bytes[] memory c = new bytes[](2);
        c[0] = abi.encodeWithSignature("finalize(uint256)", _rid());
        c[1] = abi.encodeWithSignature("dispute(uint256)", _rid());
        vm.warp(seasonEnd + DATA_LAG);
        uint256 bond = oracle.requiredBond(_rid());
        _fund(reporter, bond);
        vm.startPrank(reporter);
        token.approve(address(oracle), bond);
        hook.arm(address(oracle), c);
        oracle.propose(LOC, YEAR, 1000, 500, 1000, 500, bond);
        vm.stopPrank();
        _assertAllBlocked();
        hook.disarm();
    }
}
