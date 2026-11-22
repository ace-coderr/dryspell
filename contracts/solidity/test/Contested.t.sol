// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {PolicyBook} from "../src/PolicyBook.sol";
import {IWeatherOracle} from "../src/interfaces/IWeatherOracle.sol";

/// @dev the source-disagreement rule: sources on opposite sides of the trigger, or further apart than
///      maxSpreadBps of their mean, mean the policy does not pay automatically. The resolver rules.
contract ContestedTest is Base {
    uint256 id;

    event PolicyContested(
        uint256 indexed policyId,
        address indexed holder,
        uint256 era5X,
        uint256 powerX,
        uint256 spreadBps,
        bool oppositeSides,
        bool replay
    );

    function setUp() public override {
        super.setUp();
        id = _buy(buyer, T_DRY, 200, 1_000 * USD); // drought: pays if the season total is at or below 200 mm
    }

    function _status() internal view returns (PolicyBook.Status) {
        return book.getPolicy(id).status;
    }

    // ------------------------------------------------------------ detection
    function test_sources_on_opposite_sides_of_the_trigger_are_contested() public {
        // ERA5 says 190 mm (pays), POWER says 260 mm (does not): their median 225 mm would NOT pay, but it must not decide
        _finalizeUndisputed(1900, 800, 2600, 900);
        uint256 vaultBefore = vault.totalAssets();
        vm.expectEmit(true, true, false, true, address(book));
        emit PolicyContested(id, buyer, 1900, 2600, 3111, true, false); // 700/2250 = 31.1% apart
        book.settle(id);
        assertEq(uint8(_status()), uint8(PolicyBook.Status.Contested));
        assertEq(engine.totalExposure(), 1_000 * USD, "cover stays reserved until the resolver rules");
        assertEq(vault.totalAssets(), vaultBefore, "nothing moved");
        assertEq(book.contestedAt(id), block.timestamp);
        assertEq(oracle.rewardPool(), 0, "no oracle fee until the policy is decided");
    }

    function test_a_spread_of_exactly_the_limit_is_still_automatic() public {
        // both well under 200 mm, but 90 mm vs 150 mm is 50.0% of the mean: exactly at the limit, still automatic
        _finalizeUndisputed(900, 400, 1500, 600);
        book.settle(id);
        assertEq(uint8(_status()), uint8(PolicyBook.Status.PaidOut), "spread of exactly 50% is allowed");
    }

    function test_spread_one_tick_over_the_limit_is_contested() public {
        uint256 id2 = _buy(buyer2, T_DRY, 200, 100 * USD);
        // 1251 vs 750: |diff| / mean = 501 / 1000.5 = 50.07% > 50%
        _finalizeUndisputed(1251, 500, 750, 300);
        book.settle(id2);
        assertEq(uint8(book.getPolicy(id2).status), uint8(PolicyBook.Status.Contested));
    }

    function test_agreeing_sources_still_settle_automatically() public {
        _finalizeUndisputed(1500, 700, 1700, 800); // 150 vs 170 mm: same side, 12% apart
        book.settle(id);
        assertEq(uint8(_status()), uint8(PolicyBook.Status.PaidOut));
        assertEq(engine.totalExposure(), 0);
    }

    function test_a_contested_policy_cannot_be_settled_again() public {
        _finalizeUndisputed(1900, 800, 2600, 900);
        book.settle(id);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.NotActive.selector, PolicyBook.Status.Contested));
        book.settle(id);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.NotActive.selector, PolicyBook.Status.Contested));
        book.refund(id);
    }

    // ------------------------------------------------------------ resolver
    function test_resolver_can_pay_a_contested_policy() public {
        _finalizeUndisputed(1900, 800, 2600, 900);
        book.settle(id);
        uint256 before = token.balanceOf(buyer);
        vm.prank(resolver);
        book.resolveContested(id, true);
        assertEq(token.balanceOf(buyer), before + 1_000 * USD);
        assertEq(uint8(_status()), uint8(PolicyBook.Status.PaidOut));
        assertEq(engine.totalExposure(), 0);
        assertGt(oracle.rewardPool(), 0, "oracle fee paid once the policy is decided");
    }

    function test_resolver_can_decline_a_contested_policy() public {
        _finalizeUndisputed(1900, 800, 2600, 900);
        book.settle(id);
        uint256 before = token.balanceOf(buyer);
        vm.prank(resolver);
        book.resolveContested(id, false);
        assertEq(token.balanceOf(buyer), before);
        assertEq(uint8(_status()), uint8(PolicyBook.Status.Expired));
        assertEq(engine.totalExposure(), 0);
    }

    function test_only_the_resolver_decides_and_only_contested_policies() public {
        _finalizeUndisputed(1900, 800, 2600, 900);
        book.settle(id);
        address[4] memory nope = [buyer, owner, reporter, stranger];
        for (uint256 i; i < nope.length; ++i) {
            vm.prank(nope[i]);
            vm.expectRevert(PolicyBook.NotResolver.selector);
            book.resolveContested(id, true);
        }
        vm.startPrank(resolver);
        book.resolveContested(id, true);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.NotContested.selector, PolicyBook.Status.PaidOut));
        book.resolveContested(id, true); // no double payout
        vm.expectRevert(PolicyBook.UnknownPolicy.selector);
        book.resolveContested(999, true);
        vm.stopPrank();
    }

    function test_resolver_cannot_touch_an_ordinary_active_policy() public {
        vm.prank(resolver);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.NotContested.selector, PolicyBook.Status.Active));
        book.resolveContested(id, true);
    }

    // ------------------------------------------------------------- timeout
    function test_silent_resolver_means_a_full_refund_not_a_stuck_policy() public {
        _finalizeUndisputed(1900, 800, 2600, 900);
        book.settle(id);
        uint256 premium = book.getPolicy(id).premium;
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.ContestWindowOpen.selector, block.timestamp + CONTEST_TIMEOUT));
        book.refundContested(id);

        vm.warp(block.timestamp + CONTEST_TIMEOUT + 1);
        vm.prank(resolver);
        vm.expectRevert(PolicyBook.ContestWindowClosed.selector);
        book.resolveContested(id, true);

        uint256 before = token.balanceOf(buyer);
        vm.prank(stranger);
        book.refundContested(id);
        assertEq(token.balanceOf(buyer), before + premium);
        assertEq(uint8(_status()), uint8(PolicyBook.Status.Refunded));
        assertEq(engine.totalExposure(), 0);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.NotContested.selector, PolicyBook.Status.Refunded));
        book.refundContested(id);
    }

    function test_refundContested_needs_a_contested_policy() public {
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.NotContested.selector, PolicyBook.Status.Active));
        book.refundContested(id);
    }

    // ------------------------------------------------------- replay labels
    function test_contested_events_carry_the_replay_flag() public {
        vm.prank(owner);
        oracle.openReplay(LOC, 2025);
        (uint256 premium,,,,) = book.quote(T_DRY, 2025, 200, 100 * USD);
        _fund(buyer2, premium);
        vm.startPrank(buyer2);
        token.approve(address(book), premium);
        uint256 rid2 = book.buy(T_DRY, 2025, 200, 100 * USD, premium);
        vm.stopPrank();
        uint256 round = (LOC << 16) | 2025;
        uint256 bond = oracle.requiredBond(round);
        _fund(reporter, bond);
        vm.startPrank(reporter);
        token.approve(address(oracle), bond);
        oracle.propose(LOC, 2025, 1900, 800, 2600, 900, bond);
        vm.stopPrank();
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        oracle.finalize(round);
        vm.expectEmit(true, true, false, true, address(book));
        emit PolicyContested(rid2, buyer2, 1900, 2600, 3111, true, true);
        book.settle(rid2);
    }

    // ---------------------------------------------------------------- views
    function test_oracle_exposes_the_calibrated_sources_only_when_final() public {
        vm.expectRevert(abi.encodeWithSignature("WrongState(uint8)", uint8(IWeatherOracle.State.None)));
        oracle.calibratedSources(_rid(), 0);
        _finalizeUndisputed(1900, 800, 2600, 900);
        (uint256 e, uint256 w) = oracle.calibratedSources(_rid(), 0);
        assertEq(e, 1900);
        assertEq(w, 2600);
        (e, w) = oracle.calibratedSources(_rid(), 1);
        assertEq(e, 800);
        assertEq(w, 900);
        assertEq(oracle.maxSpreadBps(), MAX_SPREAD);
    }
}

