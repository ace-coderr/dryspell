// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {PolicyBook} from "../src/PolicyBook.sol";
import {IDryspellEngine} from "../src/interfaces/IDryspellEngine.sol";
import {IWeatherOracle} from "../src/interfaces/IWeatherOracle.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract PolicyBookTest is Base {
    // ------------------------------------------------------------- buying
    function test_buy_happy_path() public {
        uint256 payout = 1_000 * USD;
        (uint256 premium, uint256 p, uint256 se, uint256 rate, bool replay) = book.quote(T_DRY, YEAR, 150, payout);
        // p = 12_500 ppm, se = 4_000, margin = max(6_000, 2_000) -> rate 23_125 ppm
        assertEq(p, 12_500);
        assertEq(se, 4_000);
        assertEq(rate, 23_125);
        assertEq(premium, 23_125_000);
        assertFalse(replay);

        uint256 assetsBefore = vault.totalAssets();
        uint256 id = _buy(buyer, T_DRY, 150, payout);

        PolicyBook.Policy memory pol = book.getPolicy(id);
        assertEq(pol.holder, buyer);
        assertEq(pol.payout, payout);
        assertEq(pol.premium, premium);
        assertEq(pol.trigger, 150);
        assertEq(pol.tableId, T_DRY);
        assertEq(pol.year, YEAR);
        assertEq(uint8(pol.status), uint8(PolicyBook.Status.Active));
        assertEq(vault.totalAssets(), assetsBefore + premium, "premium reaches the vault");
        assertEq(engine.totalExposure(), payout, "payout reserved");
        assertEq(book.roundExposure(_rid()), payout);
        assertEq(book.roundPolicies(_rid()), 1);
        assertEq(token.balanceOf(address(book)), 0, "book never holds funds");
        assertEq(book.engineKind(), "solidity-fallback");
    }

    function test_buy_emits_event() public {
        (uint256 premium,,,,) = book.quote(T_DRY, YEAR, 150, 1_000 * USD);
        _fund(buyer, premium);
        vm.startPrank(buyer);
        token.approve(address(book), premium);
        vm.expectEmit(true, true, true, true, address(book));
        emit PolicyBought(1, buyer, _rid(), T_DRY, YEAR, 150, 1_000 * USD, premium, false);
        book.buy(T_DRY, YEAR, 150, 1_000 * USD, premium);
        vm.stopPrank();
    }

    event PolicyBought(
        uint256 indexed policyId,
        address indexed holder,
        uint256 indexed roundId,
        uint256 tableId,
        uint256 year,
        uint256 trigger,
        uint256 payout,
        uint256 premium,
        bool replay
    );

    function test_waiting_period_boundaries() public {
        // exactly LEAD before the season starts: allowed
        vm.warp(seasonStart - LEAD);
        _buy(buyer, T_DRY, 150, 100 * USD);
        // one second later: too late (this is what stops buying on a forecast storm)
        vm.warp(seasonStart - LEAD + 1);
        (uint256 premium,,,) = engine.quote(T_DRY, 150, 100 * USD);
        _fund(buyer, premium);
        vm.startPrank(buyer);
        token.approve(address(book), premium);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.TooLate.selector, seasonStart - LEAD));
        book.buy(T_DRY, YEAR, 150, 100 * USD, premium);
        vm.stopPrank();
        // mid-season and after: also rejected
        vm.warp(seasonStart + 10 days);
        vm.startPrank(buyer);
        vm.expectRevert();
        book.buy(T_DRY, YEAR, 150, 100 * USD, premium);
        vm.stopPrank();
    }

    function test_too_far_in_advance_rejected() public {
        vm.warp(seasonStart - HORIZON - 1);
        vm.startPrank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.TooEarlyToBuy.selector, seasonStart - HORIZON));
        book.buy(T_DRY, YEAR, 150, 100 * USD, type(uint256).max);
        vm.stopPrank();
    }

    function test_slippage_guard() public {
        (uint256 premium,,,,) = book.quote(T_DRY, YEAR, 150, 1_000 * USD);
        _fund(buyer, premium);
        vm.startPrank(buyer);
        token.approve(address(book), premium);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.PremiumAboveMax.selector, premium));
        book.buy(T_DRY, YEAR, 150, 1_000 * USD, premium - 1);
        vm.stopPrank();
        // and a repricing between quote and buy is caught: owner raises the loading
        vm.prank(owner);
        engine.setPricingParams(15_000, 2_000, 5_000, 700_000, 8_000);
        vm.startPrank(buyer);
        vm.expectRevert();
        book.buy(T_DRY, YEAR, 150, 1_000 * USD, premium);
        vm.stopPrank();
    }

    function test_rejects_dust_unknown_and_mismatched_tables() public {
        vm.startPrank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.PayoutTooSmall.selector, MIN_PAYOUT));
        book.buy(T_DRY, YEAR, 150, MIN_PAYOUT - 1, type(uint256).max);
        vm.expectRevert(PolicyBook.UnknownSeason.selector);
        book.buy(4, YEAR, 150, 100 * USD, type(uint256).max); // season 2 is not defined
        vm.expectRevert(PolicyBook.YearOutOfRange.selector);
        book.buy(T_DRY, 2019, 150, 100 * USD, type(uint256).max);
        vm.stopPrank();

        // a table whose peril does not match its id parity is refused
        vm.startPrank(owner);
        oracle.defineSeason(1, 6, 1, 9, 30);
        uint32[] memory l = new uint32[](2);
        l[0] = 20;
        l[1] = 10; // flood levels descend
        uint32[] memory p = new uint32[](2);
        p[0] = 1_000;
        p[1] = 2_000;
        uint32[] memory se = new uint32[](2);
        engine.loadTable(2, 0, 1, l, p, se); // id 2 must be a drought table, loaded as flood
        vm.stopPrank();
        vm.startPrank(buyer);
        vm.expectRevert(PolicyBook.TableMismatch.selector);
        book.buy(2, YEAR, 15, 100 * USD, type(uint256).max);
        vm.stopPrank();
    }

    function test_disabled_table_cannot_be_bought_but_policies_still_settle() public {
        uint256 id = _buy(buyer, T_DRY, 200, 100 * USD);
        vm.prank(owner);
        engine.setTableEnabled(T_DRY, false);
        vm.startPrank(buyer2);
        vm.expectRevert(IDryspellEngine.TableDisabled.selector);
        book.buy(T_DRY, YEAR, 200, 100 * USD, type(uint256).max);
        vm.stopPrank();
        _finalizeUndisputed(2000, 1000, 2000, 1000); // 200mm: boundary, triggers
        book.settle(id);
        assertEq(engine.totalExposure(), 0);
    }

    function test_pause_stops_sales_not_settlement() public {
        uint256 id = _buy(buyer, T_DRY, 200, 100 * USD);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        book.setPaused(true);
        vm.prank(owner);
        book.setPaused(true);
        vm.startPrank(buyer2);
        vm.expectRevert(PolicyBook.PausedError.selector);
        book.buy(T_DRY, YEAR, 200, 100 * USD, type(uint256).max);
        vm.stopPrank();
        _finalizeUndisputed(1000, 500, 1000, 500);
        book.settle(id); // still works
    }

    // ------------------------------------------------------------- caps
    function test_region_peril_cap_enforced_at_the_boundary() public {
        _buy(buyer, T_DRY, 100, 250_000 * USD); // exactly 25% of 1,000,000
        (uint256 premium,,,,) = book.quote(T_DRY, YEAR, 100, 1 * USD);
        _fund(buyer, premium + USD);
        vm.startPrank(buyer);
        token.approve(address(book), type(uint256).max);
        // the engine measures against the vault, which now also holds the premium just paid
        uint256 head = engine.headroom(T_DRY);
        vm.expectRevert(abi.encodeWithSelector(IDryspellEngine.CapBreached.selector, uint8(1)));
        book.buy(T_DRY, YEAR, 100, head + 1 * USD < MIN_PAYOUT ? MIN_PAYOUT : head + 1 * USD, type(uint256).max);
        vm.stopPrank();
        // flood has its own cap in the same region
        _buy(buyer2, T_FLOOD, 100, 250_000 * USD);
    }

    function test_total_utilization_cap() public {
        vm.startPrank(owner);
        engine.setCap(0, 0, 6_000);
        engine.setCap(0, 1, 6_000);
        vm.stopPrank();
        _buy(buyer, T_DRY, 100, 600_000 * USD);
        _buy(buyer2, T_FLOOD, 100, 190_000 * USD); // total 790k of the ~1.0M pool (80% cap)
        uint256 head = engine.headroom(T_FLOOD);
        assertGt(head, 0);
        _fund(buyer2, 100_000 * USD);
        vm.startPrank(buyer2);
        token.approve(address(book), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(IDryspellEngine.CapBreached.selector, uint8(2)));
        book.buy(T_FLOOD, YEAR, 100, head + 1, type(uint256).max);
        vm.stopPrank();
    }

    // -------------------------------------------------------- settlement
    function test_drought_triggered_pays_holder_and_releases_exposure() public {
        uint256 payout = 1_000 * USD;
        uint256 id = _buy(buyer, T_DRY, 200, payout);
        uint256 premium = book.getPolicy(id).premium;
        uint256 buyerBefore = token.balanceOf(buyer);
        uint256 vaultBefore = vault.totalAssets();

        _finalizeUndisputed(1500, 700, 1500, 700); // season total 150 mm <= trigger 200
        uint256 supply = token.totalSupply();
        vm.prank(stranger); // anyone can settle; the payout still goes to the holder
        book.settle(id);

        assertEq(token.balanceOf(buyer), buyerBefore + payout);
        uint256 fee = (premium * FEE_BPS) / 10_000;
        assertEq(vault.totalAssets(), vaultBefore - payout - fee);
        assertEq(engine.totalExposure(), 0);
        assertEq(uint8(book.getPolicy(id).status), uint8(PolicyBook.Status.PaidOut));
        assertEq(token.balanceOf(address(book)), 0, "fee forwarded, nothing stranded");
        assertEq(token.totalSupply(), supply, "no tokens created or destroyed");
        assertEq(token.balanceOf(stranger), 0);
    }

    function test_drought_not_triggered_expires_and_premium_stays_as_yield() public {
        uint256 id = _buy(buyer, T_DRY, 200, 1_000 * USD);
        uint256 premium = book.getPolicy(id).premium;
        _finalizeUndisputed(2500, 900, 2500, 900); // 250 mm > 200
        uint256 buyerBefore = token.balanceOf(buyer);
        uint256 vaultBefore = vault.totalAssets();
        book.settle(id);
        assertEq(token.balanceOf(buyer), buyerBefore);
        uint256 fee = (premium * FEE_BPS) / 10_000;
        assertEq(vault.totalAssets(), vaultBefore - fee);
        assertEq(engine.totalExposure(), 0);
        assertEq(uint8(book.getPolicy(id).status), uint8(PolicyBook.Status.Expired));
    }

    function test_settlement_boundaries_are_exact() public {
        // drought pays at <=, flood pays at >= (settlement units are 0.05 mm, trigger is whole mm)
        uint256 d = _buy(buyer, T_DRY, 200, 100 * USD);
        uint256 f = _buy(buyer2, T_FLOOD, 150, 100 * USD);
        // total = 4000 -> 200.00 mm: drought triggers; max3 = 3000 -> 150.00 mm: flood triggers
        _finalizeUndisputed(2000, 1500, 2000, 1500);
        book.settle(d);
        book.settle(f);
        assertEq(uint8(book.getPolicy(d).status), uint8(PolicyBook.Status.PaidOut));
        assertEq(uint8(book.getPolicy(f).status), uint8(PolicyBook.Status.PaidOut));
    }

    function test_one_tick_past_the_boundary_does_not_pay() public {
        uint256 d = _buy(buyer, T_DRY, 200, 100 * USD);
        uint256 f = _buy(buyer2, T_FLOOD, 150, 100 * USD);
        // both sources agree: total = 4002 (200.1 mm) > 200 -> no drought payout; max3 = 2998 (149.9 mm) < 150 -> no flood payout
        _finalizeUndisputed(2001, 1499, 2001, 1499);
        book.settle(d);
        book.settle(f);
        assertEq(uint8(book.getPolicy(d).status), uint8(PolicyBook.Status.Expired));
        assertEq(uint8(book.getPolicy(f).status), uint8(PolicyBook.Status.Expired));
    }

    function test_cannot_settle_before_final_or_twice() public {
        uint256 id = _buy(buyer, T_DRY, 200, 100 * USD);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.RoundNotFinal.selector, IWeatherOracle.State.None));
        book.settle(id);
        _propose(1000, 500, 1000, 500);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.RoundNotFinal.selector, IWeatherOracle.State.Proposed));
        book.settle(id);
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        oracle.finalize(_rid());
        book.settle(id);
        // double payout is impossible
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.NotActive.selector, PolicyBook.Status.PaidOut));
        book.settle(id);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.NotActive.selector, PolicyBook.Status.PaidOut));
        book.refund(id);
        vm.expectRevert(PolicyBook.UnknownPolicy.selector);
        book.settle(999);
    }

    function test_settleMany_settles_a_batch_and_rejects_a_repeat() public {
        uint256 a = _buy(buyer, T_DRY, 200, 100 * USD);
        uint256 b = _buy(buyer2, T_DRY, 250, 100 * USD);
        _finalizeUndisputed(1000, 500, 1000, 500);
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        book.settleMany(ids);
        assertEq(engine.totalExposure(), 0);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.NotActive.selector, PolicyBook.Status.PaidOut));
        book.settleMany(ids);
    }

    function test_oracle_fee_funds_reporter_rewards() public {
        uint256 id = _buy(buyer, T_DRY, 200, 1_000 * USD);
        uint256 premium = book.getPolicy(id).premium;
        _finalizeUndisputed(2500, 900, 2500, 900);
        uint256 poolBefore = oracle.rewardPool();
        book.settle(id);
        assertEq(oracle.rewardPool(), poolBefore + (premium * FEE_BPS) / 10_000);
    }

    // ------------------------------------------------------------ refunds
    function test_unreported_round_is_voided_and_premiums_refunded() public {
        uint256 id = _buy(buyer, T_DRY, 200, 1_000 * USD);
        uint256 premium = book.getPolicy(id).premium;
        uint256 buyerBefore = token.balanceOf(buyer);

        vm.expectRevert(abi.encodeWithSelector(PolicyBook.RoundNotVoid.selector, IWeatherOracle.State.None));
        book.refund(id);

        vm.warp(seasonEnd + DATA_LAG + REPORT_WINDOW + 1);
        oracle.voidUnreported(_rid());
        book.refund(id);
        assertEq(token.balanceOf(buyer), buyerBefore + premium, "premium returned in full");
        assertEq(engine.totalExposure(), 0);
        assertEq(uint8(book.getPolicy(id).status), uint8(PolicyBook.Status.Refunded));
        // cannot be refunded twice
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.NotActive.selector, PolicyBook.Status.Refunded));
        book.refund(id);
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.NotActive.selector, PolicyBook.Status.Refunded));
        book.settle(id);
    }

    function test_voided_round_can_never_be_settled() public {
        uint256 id = _buy(buyer, T_DRY, 200, 100 * USD);
        vm.warp(seasonEnd + DATA_LAG + REPORT_WINDOW + 1);
        oracle.voidUnreported(_rid());
        vm.expectRevert(abi.encodeWithSelector(PolicyBook.RoundNotFinal.selector, IWeatherOracle.State.Void));
        book.settle(id);
    }

    // ------------------------------------------------------------- replay
    function test_replay_round_allows_buying_a_finished_season() public {
        // 2025 monsoon is over; without a replay round it cannot be bought
        vm.startPrank(buyer);
        vm.expectRevert();
        book.buy(T_DRY, 2025, 150, 100 * USD, type(uint256).max);
        vm.stopPrank();

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oracle.openReplay(LOC, 2025);
        vm.prank(owner);
        oracle.openReplay(LOC, 2025);

        (uint256 premium,,,, bool replay) = book.quote(T_DRY, 2025, 150, 100 * USD);
        assertTrue(replay, "flagged as replay");
        _fund(buyer, premium);
        vm.startPrank(buyer);
        token.approve(address(book), premium);
        uint256 id = book.buy(T_DRY, 2025, 150, 100 * USD, premium);
        vm.stopPrank();
        assertEq(book.getPolicy(id).year, 2025);

        // once a report exists, no more buying (no information advantage)
        uint256 rid = (LOC << 16) | 2025;
        uint256 bond = oracle.requiredBond(rid);
        _fund(reporter, bond);
        vm.startPrank(reporter);
        token.approve(address(oracle), bond);
        oracle.propose(LOC, 2025, 1000, 500, 1000, 500, bond);
        vm.stopPrank();
        vm.startPrank(buyer2);
        vm.expectRevert(PolicyBook.RoundAlreadyReporting.selector);
        book.buy(T_DRY, 2025, 150, 100 * USD, type(uint256).max);
        vm.stopPrank();
    }

    event Proposed(
        uint256 indexed roundId,
        address indexed proposer,
        uint32 era5Total,
        uint32 era5Max3,
        uint32 powerTotal,
        uint32 powerMax3,
        uint256 bond,
        bool replay
    );
    event Finalized(uint256 indexed roundId, uint256 totalX2, uint256 max3X2, bool disputed, bool replay);
    event PolicySettled(
        uint256 indexed policyId,
        address indexed holder,
        bool triggered,
        uint256 payout,
        uint256 settlementX2,
        bool replay
    );

    /// @dev every event of a replay carries replay = true; a real forward season carries false
    function test_replay_flag_is_in_every_event() public {
        vm.prank(owner);
        oracle.openReplay(LOC, 2025);
        (uint256 premium,,,,) = book.quote(T_DRY, 2025, 200, 100 * USD);
        _fund(buyer, premium);
        vm.startPrank(buyer);
        token.approve(address(book), premium);
        vm.expectEmit(true, true, true, true, address(book));
        emit PolicyBought(1, buyer, (LOC << 16) | 2025, T_DRY, 2025, 200, 100 * USD, premium, true);
        book.buy(T_DRY, 2025, 200, 100 * USD, premium);
        vm.stopPrank();

        uint256 rid = (LOC << 16) | 2025;
        uint256 bond = oracle.requiredBond(rid);
        _fund(reporter, bond);
        vm.startPrank(reporter);
        token.approve(address(oracle), bond);
        vm.expectEmit(true, true, false, true, address(oracle));
        emit Proposed(rid, reporter, 1000, 500, 1000, 500, bond, true);
        oracle.propose(LOC, 2025, 1000, 500, 1000, 500, bond);
        vm.stopPrank();
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.expectEmit(true, false, false, true, address(oracle));
        emit Finalized(rid, 2000, 1000, false, true);
        oracle.finalize(rid);
        vm.expectEmit(true, true, false, true, address(book));
        emit PolicySettled(1, buyer, true, 100 * USD, 2000, true);
        book.settle(1);

        // the same flow on a real forward season reports replay = false
        uint256 fwd = _buy(buyer2, T_DRY, 200, 100 * USD);
        _finalizeUndisputed(2500, 900, 2500, 900);
        vm.expectEmit(true, true, false, true, address(book));
        emit PolicySettled(fwd, buyer2, false, 0, 5000, false);
        book.settle(fwd);
    }

    // -------------------------------------------------------------- fuzz
    function testFuzz_premium_never_below_fair_value_and_always_below_payout(uint256 trigger, uint256 payout) public {
        trigger = bound(trigger, 100, 300);
        payout = bound(payout, MIN_PAYOUT, 200_000 * USD);
        (uint256 premium, uint256 p,,,) = book.quote(T_DRY, YEAR, trigger, payout);
        assertGe(premium * 1e6, payout * p, "never cheaper than fitted fair value");
        assertLt(premium, payout);
        uint256 id = _buy(buyer, T_DRY, trigger, payout);
        assertEq(engine.totalExposure(), payout);
        assertEq(book.getPolicy(id).premium, premium);
    }

    function testFuzz_settlement_matches_trigger_rule(uint32 era, uint32 pow, uint256 trigger) public {
        trigger = bound(trigger, 100, 300);
        era = uint32(bound(era, 0, 6000));
        pow = uint32(bound(pow, 0, 6000));
        uint256 id = _buy(buyer, T_DRY, trigger, 50 * USD);
        _finalizeUndisputed(era, era / 2, pow, pow / 2);
        book.settle(id);

        // reference model of the rule: opposite sides or spread > 50% of the mean => contested
        uint256 t10 = trigger * 10;
        bool eSays = era <= t10;
        bool wSays = pow <= t10;
        uint256 sum = uint256(era) + pow;
        uint256 diff = era > pow ? era - pow : pow - era;
        bool contested = (eSays != wSays) || (sum != 0 && (diff * 20_000) / sum > 5_000);
        PolicyBook.Status st = book.getPolicy(id).status;
        if (contested) {
            assertEq(uint8(st), uint8(PolicyBook.Status.Contested));
            assertEq(engine.totalExposure(), 50 * USD, "exposure stays reserved while contested");
        } else {
            bool pays = uint256(era) + pow <= trigger * 20;
            assertEq(uint8(st), pays ? uint8(PolicyBook.Status.PaidOut) : uint8(PolicyBook.Status.Expired));
        }
    }
}
