// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {TestUSD} from "../src/TestUSD.sol";
import {DryspellEngineSol} from "../src/DryspellEngineSol.sol";
import {UnderwriterVault} from "../src/UnderwriterVault.sol";
import {WeatherOracle} from "../src/WeatherOracle.sol";
import {PolicyBook} from "../src/PolicyBook.sol";
import {IDryspellEngine} from "../src/interfaces/IDryspellEngine.sol";
import {IWeatherOracle} from "../src/interfaces/IWeatherOracle.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SeasonCalendar} from "../src/lib/SeasonCalendar.sol";

/// @dev shared deployment + helpers for every test suite
abstract contract Base is Test {
    uint256 constant USD = 1e6;
    uint256 constant LOC = 0; // location-season id: a Jun 1 - Sep 30 monsoon
    uint256 constant T_DRY = 0; // LOC * 2 + 0
    uint256 constant T_FLOOD = 1; // LOC * 2 + 1
    uint256 constant YEAR = 2027;

    address owner = makeAddr("owner");
    address public resolver = makeAddr("resolver");
    address uw = makeAddr("underwriter");
    address buyer = makeAddr("buyer");
    address buyer2 = makeAddr("buyer2");
    address reporter = makeAddr("reporter");
    address disputer = makeAddr("disputer");
    address stranger = makeAddr("stranger");

    TestUSD public token;
    DryspellEngineSol public engine;
    UnderwriterVault public vault;
    WeatherOracle public oracle;
    PolicyBook public book;

    uint256 seasonStart;
    uint256 seasonEnd;

    // oracle parameters
    uint256 constant DATA_LAG = 6 days;
    uint256 constant DISPUTE_WINDOW = 1 days;
    uint256 constant RESOLVER_TIMEOUT = 3 days;
    uint256 constant REPORT_WINDOW = 30 days;
    uint256 constant MIN_BOND = 100 * USD;
    uint256 constant BOND_BPS = 1_000;
    uint256 constant REWARD = 5 * USD;
    // book parameters
    uint256 constant LEAD = 14 days;
    uint256 constant HORIZON = 400 days;
    uint256 constant MIN_PAYOUT = 10 * USD;
    uint256 constant FEE_BPS = 200;

    function setUp() public virtual {
        (seasonStart, seasonEnd) = SeasonCalendar.window(YEAR, 6, 1, 9, 30);
        vm.warp(seasonStart - 60 days);

        token = _deployToken();
        engine = new DryspellEngineSol(owner);
        vault = new UnderwriterVault(IERC20(address(token)), IDryspellEngine(address(engine)), 1 days, owner);
        oracle = new WeatherOracle(
            IERC20(address(token)), owner, resolver, DATA_LAG, DISPUTE_WINDOW, RESOLVER_TIMEOUT, REPORT_WINDOW, MIN_BOND, BOND_BPS, REWARD, true
        );
        book = new PolicyBook(
            IERC20(address(token)),
            IDryspellEngine(address(engine)),
            vault,
            IWeatherOracle(address(oracle)),
            owner,
            LEAD,
            HORIZON,
            MIN_PAYOUT,
            FEE_BPS
        );

        vm.startPrank(owner);
        engine.setBook(address(book));
        engine.setVault(address(vault));
        vault.setBook(address(book));
        oracle.setBook(address(book));

        engine.setCap(0, 0, 2_500); // region 0 drought: 25% of vault assets
        engine.setCap(0, 1, 2_500); // region 0 flood: 25%
        _loadTables();
        oracle.defineSeason(LOC, 6, 1, 9, 30);
        oracle.defineCalibration(LOC, 0, 1_000_000, 1_000_000);
        oracle.defineCalibration(LOC, 1, 1_000_000, 1_000_000);
        vm.stopPrank();

        // underwriters seed the pool
        _deposit(uw, 1_000_000 * USD);
    }

    function _deployToken() internal virtual returns (TestUSD) {
        return new TestUSD();
    }

    function _loadTables() internal {
        uint32[] memory dl = new uint32[](3);
        dl[0] = 100;
        dl[1] = 200;
        dl[2] = 300;
        uint32[] memory fl = new uint32[](3);
        fl[0] = 200;
        fl[1] = 150;
        fl[2] = 100;
        uint32[] memory p = new uint32[](3);
        p[0] = 5_000;
        p[1] = 20_000;
        p[2] = 100_000;
        uint32[] memory se = new uint32[](3);
        se[0] = 2_000;
        se[1] = 6_000;
        se[2] = 30_000;
        engine.loadTable(T_DRY, 0, 0, dl, p, se);
        engine.loadTable(T_FLOOD, 0, 1, fl, p, se);
    }

    // ------------------------------------------------------------- helpers
    function _fund(address who, uint256 amt) internal {
        deal(address(token), who, token.balanceOf(who) + amt, true);
    }

    function _deposit(address who, uint256 amt) internal {
        _fund(who, amt);
        vm.startPrank(who);
        token.approve(address(vault), amt);
        vault.deposit(amt, who);
        vm.stopPrank();
    }

    /// @return id policy id
    function _buy(address who, uint256 table, uint256 trigger, uint256 payout) internal returns (uint256 id) {
        (uint256 prem,,,,) = book.quote(table, YEAR, trigger, payout);
        _fund(who, prem);
        vm.startPrank(who);
        token.approve(address(book), prem);
        id = book.buy(table, YEAR, trigger, payout, prem);
        vm.stopPrank();
    }

    function _rid() internal pure returns (uint256) {
        return (LOC << 16) | YEAR;
    }

    /// @dev warp past the data lag and post a report; returns the bond locked
    function _propose(uint32 eraTotal, uint32 eraMax3, uint32 powTotal, uint32 powMax3) internal returns (uint256 bond) {
        if (block.timestamp < seasonEnd + DATA_LAG) vm.warp(seasonEnd + DATA_LAG);
        bond = oracle.requiredBond(_rid());
        _fund(reporter, bond);
        vm.startPrank(reporter);
        token.approve(address(oracle), bond);
        oracle.propose(LOC, YEAR, eraTotal, eraMax3, powTotal, powMax3, bond);
        vm.stopPrank();
    }

    function _finalizeUndisputed(uint32 eraTotal, uint32 eraMax3, uint32 powTotal, uint32 powMax3) internal {
        _propose(eraTotal, eraMax3, powTotal, powMax3);
        vm.warp(block.timestamp + DISPUTE_WINDOW);
        oracle.finalize(_rid());
    }

    function _dispute() internal returns (uint256 bond) {
        bond = oracle.requiredBond(_rid());
        _fund(disputer, bond);
        vm.startPrank(disputer);
        token.approve(address(oracle), bond);
        oracle.dispute(_rid());
        vm.stopPrank();
    }
}
