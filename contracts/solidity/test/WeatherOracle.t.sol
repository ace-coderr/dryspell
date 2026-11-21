// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {WeatherOracle} from "../src/WeatherOracle.sol";
import {PolicyBook} from "../src/PolicyBook.sol";
import {IWeatherOracle} from "../src/interfaces/IWeatherOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {SeasonCalendar} from "../src/lib/SeasonCalendar.sol";

contract WeatherOracleTest is Base {
    uint256 policyId;

    function setUp() public override {
        super.setUp();
        policyId = _buy(buyer, T_DRY, 200, 1_000 * USD); // 1,000 USD of exposure drives the bond: 10% = 100 -> MIN_BOND
    }

    // ------------------------------------------------------------- admin
    function test_season_and_calibration_are_set_once_and_owner_only() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oracle.defineSeason(7, 1, 1, 3, 31);
        vm.stopPrank();

        vm.startPrank(owner);
        vm.expectRevert(WeatherOracle.SeasonExists.selector);
        oracle.defineSeason(LOC, 1, 1, 3, 31);
        vm.expectRevert(WeatherOracle.CalibrationSet.selector);
        oracle.defineCalibration(LOC, 0, 900_000, 1_100_000);
        vm.expectRevert(WeatherOracle.SeasonUnknown.selector);
        oracle.defineCalibration(55, 0, 1, 1);
        vm.expectRevert(WeatherOracle.BadSeason.selector);
        oracle.defineSeason(8, 13, 1, 3, 31);
        oracle.defineSeason(8, 11, 1, 4, 30); // crosses new year
        vm.expectRevert(WeatherOracle.BadSeason.selector);
        oracle.defineCalibration(8, 0, 0, 1_000_000);
        vm.stopPrank();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        oracle.setResolver(stranger);
    }

    function test_season_window_handles_new_year_and_leap_years() public {
        vm.prank(owner);
        oracle.defineSeason(8, 11, 1, 4, 30); // Nov 1 - Apr 30
        (uint256 s, uint256 e) = oracle.seasonWindow(8, 2027);
        assertEq(s, 1825027200, "2027-11-01T00:00Z");
        assertEq(e, 1840752000, "2028-05-01T00:00Z, the exclusive end");
        // Feb 29 exists in 2028
        vm.prank(owner);
        oracle.defineSeason(9, 2, 29, 3, 1);
        (s, e) = oracle.seasonWindow(9, 2028);
        assertEq(e - s, 2 days);
        // known anchors for the calendar library
        assertEq(SeasonCalendar.daysFromCivil(1970, 1, 1), 0);
        assertEq(SeasonCalendar.daysFromCivil(2000, 3, 1), 11017);
        assertEq(SeasonCalendar.daysFromCivil(2024, 2, 29), 19782);
    }

    function test_wiring_is_one_time() public {
        vm.prank(owner);
        vm.expectRevert(WeatherOracle.BookAlreadySet.selector);
        oracle.setBook(stranger);
        vm.prank(owner);
        vm.expectRevert(WeatherOracle.ZeroAddress.selector);
        oracle.setResolver(address(0));
    }

    // ----------------------------------------------------------- proposing
    function test_propose_guards() public {
        uint256 bond = oracle.requiredBond(_rid());
        assertEq(bond, MIN_BOND);
        _fund(reporter, 10 * bond);
        vm.startPrank(reporter);
        token.approve(address(oracle), type(uint256).max);

        vm.warp(seasonEnd + DATA_LAG - 1);
        vm.expectRevert(abi.encodeWithSelector(WeatherOracle.TooEarly.selector, seasonEnd + DATA_LAG));
        oracle.propose(LOC, YEAR, 1000, 500, 1000, 500, bond);

        vm.warp(seasonEnd + DATA_LAG);
        vm.expectRevert(WeatherOracle.BadReading.selector); // 3-day max cannot exceed the total
        oracle.propose(LOC, YEAR, 1000, 1001, 1000, 500, bond);
        vm.expectRevert(WeatherOracle.BadReading.selector);
        oracle.propose(LOC, YEAR, 1000, 500, 10_000_001, 500, bond);
        vm.expectRevert(abi.encodeWithSelector(WeatherOracle.BondTooHigh.selector, bond));
        oracle.propose(LOC, YEAR, 1000, 500, 1000, 500, bond - 1);

        vm.warp(seasonEnd + DATA_LAG + REPORT_WINDOW + 1);
        vm.expectRevert(WeatherOracle.WindowClosed.selector);
        oracle.propose(LOC, YEAR, 1000, 500, 1000, 500, bond);
        vm.stopPrank();
    }

    function test_cannot_report_a_round_with_no_policies() public {
        vm.startPrank(owner);
        oracle.defineSeason(3, 6, 1, 9, 30);
        oracle.defineCalibration(3, 0, 1_000_000, 1_000_000);
        oracle.defineCalibration(3, 1, 1_000_000, 1_000_000);
        vm.stopPrank();
        vm.warp(seasonEnd + DATA_LAG);
        _fund(reporter, 1_000 * USD);
        vm.startPrank(reporter);
        token.approve(address(oracle), type(uint256).max);
        vm.expectRevert(WeatherOracle.NoPolicies.selector);
        oracle.propose(3, YEAR, 1000, 500, 1000, 500, 1_000 * USD); // nobody bought cover on this season
        vm.stopPrank();
    }

    function test_bond_scales_with_cover_at_stake() public {
        _buy(buyer2, T_DRY, 100, 200_000 * USD);
        // 10% of 201,000 USD
        assertEq(oracle.requiredBond(_rid()), 20_100 * USD);
    }

    function test_second_proposal_is_rejected() public {
        _propose(1000, 500, 1000, 500);
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(WeatherOracle.WrongState.selector, IWeatherOracle.State.Proposed));
        oracle.propose(LOC, YEAR, 9, 9, 9, 9, type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------------------------ happy path (no dispute)
    function test_undisputed_report_finalises_and_pays_bond_back_plus_reward() public {
        // reward pool needs funding first; the book's fee comes only after settlement
        _fund(stranger, 50 * USD);
        vm.startPrank(stranger);
        token.approve(address(oracle), 50 * USD);
        oracle.fundRewards(50 * USD);
        vm.stopPrank();

        uint256 bond = _propose(1500, 700, 1500, 700);
        assertEq(token.balanceOf(reporter), 0);
        assertEq(oracle.challengeEndsAt(_rid()), block.timestamp + DISPUTE_WINDOW);

        // too early to finalise
        vm.expectRevert(abi.encodeWithSelector(WeatherOracle.WindowOpen.selector, block.timestamp + DISPUTE_WINDOW));
        oracle.finalize(_rid());

        vm.warp(block.timestamp + DISPUTE_WINDOW);
        oracle.finalize(_rid());
        assertEq(token.balanceOf(reporter), bond + REWARD);
        assertEq(oracle.rewardPool(), 50 * USD - REWARD);
        (uint256 t, uint256 m) = oracle.finalValues(_rid());
        assertEq(t, 3000); // 150 mm in 0.05 mm units
        assertEq(m, 1400);
        // a second finalize is impossible
        vm.expectRevert(abi.encodeWithSelector(WeatherOracle.WrongState.selector, IWeatherOracle.State.Final));
        oracle.finalize(_rid());
    }

    function test_finalValues_revert_until_final() public {
        vm.expectRevert(abi.encodeWithSelector(WeatherOracle.WrongState.selector, IWeatherOracle.State.None));
        oracle.finalValues(_rid());
    }

    // ------------------------------------------------------------ disputes
    function test_dispute_guards() public {
        _propose(1500, 700, 1500, 700);
        // proposer cannot challenge themselves
        _fund(reporter, 1_000 * USD);
        vm.startPrank(reporter);
        token.approve(address(oracle), type(uint256).max);
        vm.expectRevert(WeatherOracle.SelfDispute.selector);
        oracle.dispute(_rid());
        vm.stopPrank();
        // the window closes
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        _fund(disputer, 1_000 * USD);
        vm.startPrank(disputer);
        token.approve(address(oracle), type(uint256).max);
        vm.expectRevert(WeatherOracle.WindowClosed.selector);
        oracle.dispute(_rid());
        vm.stopPrank();
    }

    function test_dispute_upheld_proposer_wins_the_disputers_bond() public {
        uint256 bond = _propose(1500, 700, 1500, 700);
        _dispute();
        assertEq(uint8(oracle.roundState(_rid())), uint8(IWeatherOracle.State.Disputed));
        // a finalize call cannot bypass the dispute
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        vm.expectRevert(abi.encodeWithSelector(WeatherOracle.WrongState.selector, IWeatherOracle.State.Disputed));
        oracle.finalize(_rid());

        vm.prank(resolver);
        oracle.resolve(_rid(), true, 0, 0, 0, 0);
        assertEq(token.balanceOf(reporter), 2 * bond, "reporter keeps own bond and wins the disputer's");
        assertEq(token.balanceOf(disputer), 0);
        (uint256 t,) = oracle.finalValues(_rid());
        assertEq(t, 3000, "original readings stand");
        book.settle(policyId);
        assertEq(uint8(book.getPolicy(policyId).status), uint8(PolicyBook.Status.PaidOut));
    }

    function test_dispute_overturned_reporter_is_slashed_and_resolver_readings_win() public {
        uint256 bond = _propose(1500, 700, 1500, 700); // reporter claims 150 mm: would pay the drought policy
        _dispute();
        vm.prank(resolver);
        oracle.resolve(_rid(), false, 2600, 900, 2400, 800); // truth is 250 mm
        assertEq(token.balanceOf(disputer), 2 * bond, "disputer wins the reporter's bond");
        assertEq(token.balanceOf(reporter), 0, "reporter slashed");
        (uint256 t,) = oracle.finalValues(_rid());
        assertEq(t, 5000);
        book.settle(policyId);
        assertEq(uint8(book.getPolicy(policyId).status), uint8(PolicyBook.Status.Expired), "wrong report did not pay out");
    }

    function test_only_the_resolver_resolves_and_only_inside_the_timeout() public {
        _propose(1500, 700, 1500, 700);
        // nothing to resolve yet
        vm.prank(resolver);
        vm.expectRevert(abi.encodeWithSelector(WeatherOracle.WrongState.selector, IWeatherOracle.State.Proposed));
        oracle.resolve(_rid(), true, 0, 0, 0, 0);
        _dispute();
        for (uint256 i; i < 3; ++i) {
            address who = i == 0 ? owner : i == 1 ? reporter : disputer;
            vm.prank(who);
            vm.expectRevert(WeatherOracle.NotResolver.selector);
            oracle.resolve(_rid(), true, 0, 0, 0, 0);
        }
        // the resolver must give sane readings when it overturns
        vm.prank(resolver);
        vm.expectRevert(WeatherOracle.BadReading.selector);
        oracle.resolve(_rid(), false, 100, 200, 100, 50);
        vm.warp(block.timestamp + RESOLVER_TIMEOUT + 1);
        vm.prank(resolver);
        vm.expectRevert(WeatherOracle.ResolverTimedOut.selector);
        oracle.resolve(_rid(), true, 0, 0, 0, 0);
    }

    function test_resolver_silence_voids_the_round_with_a_penalty_both_ways() public {
        uint256 bond = _propose(1500, 700, 1500, 700);
        _dispute();
        vm.expectRevert(
            abi.encodeWithSelector(WeatherOracle.ResolverStillTime.selector, block.timestamp + RESOLVER_TIMEOUT)
        );
        oracle.voidDisputed(_rid());

        uint256 poolBefore = oracle.rewardPool();
        vm.warp(block.timestamp + RESOLVER_TIMEOUT + 1);
        oracle.voidDisputed(_rid());
        uint256 penalty = (bond * oracle.VOID_PENALTY_BPS()) / 10_000;
        assertEq(token.balanceOf(reporter), bond - penalty);
        assertEq(token.balanceOf(disputer), bond - penalty);
        assertEq(oracle.rewardPool(), poolBefore + 2 * penalty);
        assertEq(uint8(oracle.roundState(_rid())), uint8(IWeatherOracle.State.Void));
        // and policyholders are made whole
        uint256 premium = book.getPolicy(policyId).premium;
        uint256 before = token.balanceOf(buyer);
        book.refund(policyId);
        assertEq(token.balanceOf(buyer), before + premium);
    }

    function test_unreported_round_void_needs_the_full_deadline() public {
        vm.warp(seasonEnd + DATA_LAG + REPORT_WINDOW);
        vm.expectRevert(abi.encodeWithSelector(WeatherOracle.TooEarly.selector, seasonEnd + DATA_LAG + REPORT_WINDOW + 1));
        oracle.voidUnreported(_rid());
        vm.warp(seasonEnd + DATA_LAG + REPORT_WINDOW + 1);
        oracle.voidUnreported(_rid());
        vm.expectRevert(abi.encodeWithSelector(WeatherOracle.WrongState.selector, IWeatherOracle.State.Void));
        oracle.voidUnreported(_rid());
    }

    // ------------------------------------------------------- calibration
    function test_calibration_is_applied_to_each_source_before_the_median() public {
        vm.startPrank(owner);
        oracle.defineSeason(5, 6, 1, 9, 30);
        oracle.defineCalibration(5, 0, 1_132_480, 895_270); // Jodhpur-style factors from the data layer
        oracle.defineCalibration(5, 1, 963_182, 1_039_745);
        vm.stopPrank();
        // 2000 + 2000 raw (200 mm each) -> (2000*1.13248 + 2000*0.89527) = 4055.5 -> 4055
        (uint256 t, uint256 m) = oracle.previewSettlement(5, 2000, 800, 2000, 800);
        assertEq(t, 4055);
        assertEq(m, 1602); // (800*963182 + 800*1039745) / 1e6 = 1602.34, floored
        // a season without calibration cannot be reported
        vm.expectRevert(WeatherOracle.CalibrationMissing.selector);
        oracle.previewSettlement(LOC + 100, 1, 1, 1, 1);
    }

    // ------------------------------------------------------------- replay
    function test_replay_is_testnet_only() public {
        WeatherOracle prod = new WeatherOracle(
            IERC20(address(token)), owner, resolver, DATA_LAG, DISPUTE_WINDOW, RESOLVER_TIMEOUT, REPORT_WINDOW, MIN_BOND, BOND_BPS, REWARD, false
        );
        vm.startPrank(owner);
        prod.defineSeason(LOC, 6, 1, 9, 30);
        vm.expectRevert(WeatherOracle.ReplayDisabled.selector);
        prod.openReplay(LOC, 2025);
        // and replaying a season that has not finished is never allowed
        vm.expectRevert(WeatherOracle.SeasonNotOver.selector);
        oracle.openReplay(LOC, 2027);
        vm.stopPrank();
    }

    // -------------------------------------------------------------- fuzz
    function testFuzz_bond_is_conserved_through_every_outcome(uint8 path, uint32 total, uint32 max3) public {
        total = uint32(bound(total, 1, 5000));
        max3 = uint32(bound(max3, 0, total));
        path = path % 3;
        uint256 supply = token.totalSupply();
        _propose(total, max3, total, max3);
        if (path == 0) {
            vm.warp(block.timestamp + DISPUTE_WINDOW);
            oracle.finalize(_rid());
        } else if (path == 1) {
            _dispute();
            vm.prank(resolver);
            oracle.resolve(_rid(), true, 0, 0, 0, 0);
        } else {
            _dispute();
            vm.warp(block.timestamp + RESOLVER_TIMEOUT + 1);
            oracle.voidDisputed(_rid());
        }
        // all bonds left the oracle again (only the reward pool remainder stays)
        assertEq(token.balanceOf(address(oracle)), oracle.rewardPool(), "no bond stuck in the oracle");
        // minted tokens come only from _fund() helper deals, never from the contracts
        assertGe(token.totalSupply(), supply);
    }
}
