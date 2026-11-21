// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Base} from "./Base.t.sol";
import {Test, console} from "forge-std/Test.sol";
import {PolicyBook} from "../src/PolicyBook.sol";
import {UnderwriterVault} from "../src/UnderwriterVault.sol";
import {WeatherOracle} from "../src/WeatherOracle.sol";
import {SeasonCalendar} from "../src/lib/SeasonCalendar.sol";
import {IWeatherOracle} from "../src/interfaces/IWeatherOracle.sol";

/// @dev random sequences of deposits, withdrawals, purchases, reports, disputes and settlements
contract Handler is Test {
    Base public sys;
    PolicyBook public book;
    address[] public actors;
    uint256 public settled;
    uint256 public bought;

    constructor(Base sys_, PolicyBook book_, address[] memory actors_) {
        sys = sys_;
        book = book_;
        actors = actors_;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function deposit(uint256 seed, uint256 amt) external {
        amt = bound(amt, 1e6, 500_000e6);
        address a = _actor(seed);
        deal(address(sys.token()), a, sys.token().balanceOf(a) + amt, true);
        vm.startPrank(a);
        sys.token().approve(address(sys.vault()), amt);
        try sys.vault().deposit(amt, a) {} catch {}
        vm.stopPrank();
    }

    function withdraw(uint256 seed, uint256 amt) external {
        address a = _actor(seed);
        uint256 wa = sys.vault().withdrawableAt(a);
        if (wa > block.timestamp) vm.warp(wa); // at most the 1-day hold period
        uint256 max = sys.vault().maxWithdraw(a);
        if (max == 0) return;
        amt = amt % 2 == 0 ? max : bound(amt, 1, max); // half the time try to take everything
        UnderwriterVault v = sys.vault();
        vm.prank(a);
        try v.withdraw(amt, a, a) {} catch {}
    }

    /// a plain 100k policy, so the pool is very likely to carry exposure when a withdrawal comes
    function buyPlain(uint256 table) external {
        buy(2, table, 150, 100_000e6, 0);
    }

    /// the largest underwriter tries to take everything out
    function withdrawAll() external {
        address a = actors[4];
        uint256 wa = sys.vault().withdrawableAt(a);
        if (wa > block.timestamp) vm.warp(wa);
        uint256 max = sys.vault().maxWithdraw(a);
        if (max == 0) return;
        UnderwriterVault v = sys.vault();
        vm.prank(a);
        try v.withdraw(max, a, a) {} catch {}
    }

    function advance(uint256 secs) external {
        vm.warp(block.timestamp + bound(secs, 1 hours, 3 days));
    }

    function buy(uint256 seed, uint256 table, uint256 trigger, uint256 payout, uint256 yearIdx) public {
        table = table % 2;
        trigger = bound(trigger, 100, 300);
        payout = bound(payout, 10e6, 300_000e6);
        uint256 year = yearIdx % 4 == 3 ? 2028 : 2027; // mostly the season that is currently buyable
        address a = _actor(seed);
        try book.quote(table, year, trigger, payout) returns (uint256 prem, uint256, uint256, uint256, bool) {
            deal(address(sys.token()), a, sys.token().balanceOf(a) + prem, true);
            vm.startPrank(a);
            sys.token().approve(address(book), prem);
            try book.buy(table, year, trigger, payout, prem) {
                bought++;
            } catch {}
            vm.stopPrank();
        } catch {}
    }

    /// report (maybe disputed) and settle every policy of one season
    function resolveSeason(uint256 yearIdx, uint256 total, uint256 outcome) external {
        uint256 year = 2027 + (yearIdx % 3);
        uint256 rid = (0 << 16) | year;
        IWeatherOracle.State st = sys.oracle().roundState(rid);
        if (st != IWeatherOracle.State.None) return;
        (, uint256 end) = SeasonCalendar.window(year, 6, 1, 9, 30);
        if (block.timestamp < end + 6 days) vm.warp(end + 6 days);
        if (block.timestamp > end + 6 days + 30 days) return;
        total = bound(total, 1, 5000);
        uint256 bond;
        try sys.oracle().requiredBond(rid) returns (uint256 b) {
            bond = b;
        } catch {
            return;
        }
        address rep = actors[0];
        deal(address(sys.token()), rep, sys.token().balanceOf(rep) + bond, true);
        vm.startPrank(rep);
        sys.token().approve(address(sys.oracle()), bond);
        try sys.oracle().propose(0, year, uint32(total), uint32(total / 2), uint32(total), uint32(total / 2), bond) {} catch {
            vm.stopPrank();
            return;
        }
        vm.stopPrank();

        uint256 path = outcome % 3;
        if (path == 0) {
            vm.warp(block.timestamp + 1 days);
            sys.oracle().finalize(rid);
        } else if (path == 1) {
            address d = actors[1];
            deal(address(sys.token()), d, sys.token().balanceOf(d) + bond, true);
            vm.startPrank(d);
            sys.token().approve(address(sys.oracle()), bond);
            sys.oracle().dispute(rid);
            vm.stopPrank();
            WeatherOracle o = sys.oracle();
            vm.prank(sys.resolver());
            o.resolve(rid, true, 0, 0, 0, 0);
        } else {
            address d = actors[1];
            deal(address(sys.token()), d, sys.token().balanceOf(d) + bond, true);
            vm.startPrank(d);
            sys.token().approve(address(sys.oracle()), bond);
            sys.oracle().dispute(rid);
            vm.stopPrank();
            vm.warp(block.timestamp + 3 days + 1);
            sys.oracle().voidDisputed(rid);
        }

        IWeatherOracle.State fin = sys.oracle().roundState(rid);
        uint256 n = book.policyCount();
        for (uint256 i = 1; i <= n; ++i) {
            PolicyBook.Policy memory p = book.getPolicy(i);
            if (p.status != PolicyBook.Status.Active || p.year != year) continue;
            if (fin == IWeatherOracle.State.Final) book.settle(i);
            else if (fin == IWeatherOracle.State.Void) book.refund(i);
            settled++;
        }
    }
}

contract InvariantsTest is Base {
    Handler handler;
    address[] actors;

    function setUp() public override {
        super.setUp();
        // define two further seasons' worth of years: same season id, different years are just round ids
        actors.push(reporter);
        actors.push(disputer);
        actors.push(buyer);
        actors.push(buyer2);
        actors.push(uw);
        handler = new Handler(this, book, actors);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](7);
        sels[5] = Handler.buyPlain.selector;
        sels[6] = Handler.withdrawAll.selector;
        sels[0] = Handler.deposit.selector;
        sels[1] = Handler.withdraw.selector;
        sels[2] = Handler.buy.selector;
        sels[3] = Handler.resolveSeason.selector;
        sels[4] = Handler.advance.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    function afterInvariant() public view {
        console.log("policies bought:", handler.bought(), "settled or refunded:", handler.settled());
    }

    /// the pool can always pay every active policy in full
    function invariant_vault_always_covers_exposure() public view {
        assertGe(vault.totalAssets(), engine.totalExposure());
    }

    /// the engine's exposure book equals the payouts of policies that are still active
    function invariant_exposure_equals_active_payouts() public view {
        uint256 sum;
        uint256 n = book.policyCount();
        for (uint256 i = 1; i <= n; ++i) {
            PolicyBook.Policy memory p = book.getPolicy(i);
            if (p.status == PolicyBook.Status.Active) sum += p.payout;
        }
        assertEq(engine.totalExposure(), sum);
    }

    /// the book is a pure router: it never keeps tokens
    function invariant_book_holds_nothing() public view {
        assertEq(token.balanceOf(address(book)), 0);
    }

    /// bonds are never trapped: whatever the oracle holds is the reward pool plus bonds of open rounds
    function invariant_oracle_balance_covers_reward_pool() public view {
        assertGe(token.balanceOf(address(oracle)), oracle.rewardPool());
    }

    /// vault accounting: balance of tokens equals totalAssets (no hidden liabilities)
    function invariant_vault_assets_are_its_token_balance() public view {
        assertEq(vault.totalAssets(), token.balanceOf(address(vault)));
    }
}

/// @dev proves the handler's actions really work (an invariant test that silently reverts proves nothing)
contract HandlerSanity is Base {
    function test_handler_can_buy_then_withdraw() public {
        address[] memory actors = new address[](5);
        actors[0] = reporter;
        actors[1] = disputer;
        actors[2] = buyer;
        actors[3] = buyer2;
        actors[4] = uw;
        Handler h = new Handler(this, book, actors);
        h.buyPlain(0);
        assertEq(h.bought(), 1, "handler purchase worked");
        assertEq(engine.totalExposure(), 100_000e6);
        h.withdrawAll();
        // the underwriter drained everything that was free, and not a unit of the collateral
        assertEq(vault.totalAssets(), engine.totalExposure());
        assertEq(engine.totalExposure(), 100_000e6);
    }
}
