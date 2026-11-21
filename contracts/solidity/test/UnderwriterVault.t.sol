// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {UnderwriterVault} from "../src/UnderwriterVault.sol";
import {PolicyBook} from "../src/PolicyBook.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IDryspellEngine} from "../src/interfaces/IDryspellEngine.sol";

contract UnderwriterVaultTest is Base {
    function test_deposit_then_withdraw_after_the_hold_period() public {
        // uw deposited 1,000,000 in setUp at the current time
        assertEq(vault.totalAssets(), 1_000_000 * USD);
        assertEq(vault.maxWithdraw(uw), 0, "still inside the hold period");
        vm.prank(uw);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, uw, 1 * USD, 0));
        vault.withdraw(1 * USD, uw, uw);

        vm.warp(block.timestamp + 1 days);
        assertApproxEqAbs(vault.maxWithdraw(uw), 1_000_000 * USD, 1);
        uint256 shares = vault.balanceOf(uw);
        vm.prank(uw);
        vault.redeem(shares, uw, uw);
        assertApproxEqAbs(token.balanceOf(uw), 1_000_000 * USD, 1);
    }

    function test_a_fresh_deposit_restarts_the_hold_period() public {
        vm.warp(block.timestamp + 2 days);
        assertGt(vault.maxWithdraw(uw), 0);
        _deposit(uw, 10 * USD);
        assertEq(vault.maxWithdraw(uw), 0);
        assertEq(vault.withdrawableAt(uw), block.timestamp + 1 days);
    }

    function test_collateral_backing_active_policies_cannot_leave() public {
        _buy(buyer, T_DRY, 100, 250_000 * USD);
        vm.warp(block.timestamp + 1 days);
        uint256 locked = vault.lockedAssets();
        assertEq(locked, 250_000 * USD);
        uint256 free = vault.freeAssets();
        assertEq(vault.maxWithdraw(uw), free);
        vm.startPrank(uw);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, uw, free + 1, free));
        vault.withdraw(free + 1, uw, uw);
        vault.withdraw(free, uw, uw);
        vm.stopPrank();
        // what remains still covers every active policy
        assertGe(vault.totalAssets(), engine.totalExposure());
        assertEq(vault.freeAssets(), 0);
    }

    function test_two_underwriters_cannot_both_withdraw_the_same_free_liquidity() public {
        address uw2 = makeAddr("uw2");
        _deposit(uw2, 1_000_000 * USD);
        _buy(buyer, T_DRY, 100, 250_000 * USD);
        _buy(buyer, T_FLOOD, 100, 250_000 * USD);
        vm.warp(block.timestamp + 1 days);
        uint256 free = vault.freeAssets();
        // each wants a bit more than half of what is free: only the first can leave
        uint256 want = free / 2 + 10 * USD;
        vm.prank(uw);
        vault.withdraw(want, uw, uw);
        vm.prank(uw2);
        vm.expectRevert();
        vault.withdraw(want, uw2, uw2);
        assertGe(vault.totalAssets(), engine.totalExposure(), "never undercollateralised");
    }

    function test_premiums_raise_the_share_price_and_payouts_lower_it() public {
        uint256 shares = vault.balanceOf(uw);
        uint256 id = _buy(buyer, T_DRY, 200, 1_000 * USD);
        uint256 premium = book.getPolicy(id).premium;
        assertEq(vault.totalAssets(), 1_000_000 * USD + premium);
        uint256 valueAfterPremium = vault.convertToAssets(shares);
        assertGt(valueAfterPremium, 1_000_000 * USD - 2, "yield accrues to underwriters");

        _finalizeUndisputed(1000, 500, 1000, 500); // drought pays
        book.settle(id);
        assertLt(vault.convertToAssets(shares), valueAfterPremium, "payout is borne by underwriters");
    }

    function test_shares_cannot_be_transferred_or_deposited_for_someone_else() public {
        uint256 shares = vault.balanceOf(uw);
        vm.prank(uw);
        vm.expectRevert(UnderwriterVault.SharesNotTransferable.selector);
        vault.transfer(stranger, shares);

        _fund(stranger, 100 * USD);
        vm.startPrank(stranger);
        token.approve(address(vault), 100 * USD);
        // depositing "for" a victim would restart their lock-up: not allowed
        vm.expectRevert(UnderwriterVault.ReceiverMustBeCaller.selector);
        vault.deposit(100 * USD, uw);
        vm.stopPrank();
        // nor can a third party redeem someone else's shares, even with an allowance
        vm.warp(block.timestamp + 1 days);
        vm.prank(stranger);
        vm.expectRevert();
        vault.redeem(1, stranger, uw);
    }

    function test_donation_attack_does_not_steal_a_later_deposit() public {
        // fresh, empty vault on the same engine
        UnderwriterVault v = new UnderwriterVault(IERC20(address(token)), IDryspellEngine(address(engine)), 1 days, owner);
        address attacker = makeAddr("attacker");
        address victim = makeAddr("victim");
        _fund(attacker, 11 * USD);
        vm.startPrank(attacker);
        token.approve(address(v), type(uint256).max);
        v.deposit(1, attacker); // 1 wei of the asset
        token.transfer(address(v), 10 * USD); // donate to inflate the share price
        vm.stopPrank();
        _fund(victim, 10 * USD);
        vm.startPrank(victim);
        token.approve(address(v), type(uint256).max);
        v.deposit(10 * USD, victim);
        vm.stopPrank();
        // the victim keeps (almost) everything they put in; the attacker lost the donation
        assertApproxEqRel(v.convertToAssets(v.balanceOf(victim)), 10 * USD, 0.01e18);
        assertLt(v.convertToAssets(v.balanceOf(attacker)), 6 * USD, "attacker lost about half of the donation");
    }

    function test_only_the_book_can_pull_funds_and_wiring_is_once() public {
        vm.prank(stranger);
        vm.expectRevert(UnderwriterVault.NotBook.selector);
        vault.payOut(stranger, 1);
        vm.prank(owner);
        vm.expectRevert(UnderwriterVault.BookAlreadySet.selector);
        vault.setBook(stranger);
        // not even the owner can take funds
        vm.prank(owner);
        vm.expectRevert(UnderwriterVault.NotBook.selector);
        vault.payOut(owner, 1);
        UnderwriterVault v = new UnderwriterVault(IERC20(address(token)), IDryspellEngine(address(engine)), 1 days, owner);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        v.setBook(stranger);
    }

    function test_utilization_view() public {
        assertEq(vault.utilizationBps(), 0);
        _buy(buyer, T_DRY, 100, 100_000 * USD);
        assertApproxEqAbs(vault.utilizationBps(), 1_000, 1); // ~10% of ~1.0M
    }

    function testFuzz_vault_never_undercollateralised_after_a_withdrawal(uint256 payout, uint256 withdrawAmt) public {
        payout = bound(payout, MIN_PAYOUT, 250_000 * USD);
        _buy(buyer, T_DRY, 100, payout);
        vm.warp(block.timestamp + 1 days);
        withdrawAmt = bound(withdrawAmt, 0, vault.maxWithdraw(uw));
        if (withdrawAmt > 0) {
            vm.prank(uw);
            vault.withdraw(withdrawAmt, uw, uw);
        }
        assertGe(vault.totalAssets(), engine.totalExposure());
    }
}
