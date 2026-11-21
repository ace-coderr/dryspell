// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDryspellEngine} from "./interfaces/IDryspellEngine.sol";
import {IWeatherOracle} from "./interfaces/IWeatherOracle.sol";
import {UnderwriterVault} from "./UnderwriterVault.sol";

/// @title PolicyBook
/// @notice Parametric weather cover. A policy covers one (location, season, peril) for one specific
///         season year: pay `premium` now, receive `payout` automatically if the oracle's settlement
///         value crosses `trigger`. No claim form and no adjuster: anyone can call `settle`.
///
///         table id = locSeasonId * 2 + peril (0 drought, 1 flood)
///         round id = locSeasonId << 16 | year
///
/// Anti front-running ("waiting period"): a policy must be bought at least `leadTime` BEFORE the season
/// starts, which is longer than weather forecasts are skilful, so the buyer has no information
/// advantage. The only exception is a testnet "replay" round opened by the owner for a past season.
///
/// Money flow: the premium goes straight to the vault (underwriters' yield). `payout` is reserved
/// in the engine (caps checked against the vault's assets). Triggered policies are paid from the vault.
contract PolicyBook is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Active,
        PaidOut, // trigger crossed, payout sent
        Expired, // trigger not crossed, no payout
        Refunded // round was voided, premium returned
    }

    struct Policy {
        address holder;
        uint16 year;
        Status status;
        uint32 trigger; // mm
        uint64 tableId;
        uint64 purchasedAt;
        uint128 payout;
        uint128 premium;
    }

    IERC20 public immutable token;
    IDryspellEngine public immutable engine;
    UnderwriterVault public immutable vault;
    IWeatherOracle public immutable oracle;
    /// @notice policies must be bought at least this long before the season starts
    uint256 public immutable leadTime;
    /// @notice ...and no more than this long before it
    uint256 public immutable maxHorizon;
    /// @notice smallest payout accepted (blocks dust spam)
    uint256 public immutable minPayout;
    /// @notice share of premium (bps) paid from the vault to the oracle reward pool when a policy settles
    uint256 public immutable oracleFeeBps;

    bool public paused;
    uint256 public policyCount;
    mapping(uint256 => Policy) private _policies;
    /// @notice total payout sold per round (drives the oracle bond size)
    mapping(uint256 => uint256) public roundExposure;
    mapping(uint256 => uint256) public roundPolicies;

    error ZeroAddress();
    error PausedError();
    error UnknownSeason();
    error TableMismatch();
    error YearOutOfRange();
    error TooLate(uint256 latestPurchase);
    error TooEarlyToBuy(uint256 earliestPurchase);
    error RoundAlreadyReporting();
    error PayoutTooSmall(uint256 min);
    error PremiumAboveMax(uint256 premium);
    error NotActive(Status status);
    error RoundNotFinal(IWeatherOracle.State state);
    error RoundNotVoid(IWeatherOracle.State state);
    error UnknownPolicy();

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
    event PolicySettled(
        uint256 indexed policyId, address indexed holder, bool triggered, uint256 payout, uint256 settlementX2
    );
    event PolicyRefunded(uint256 indexed policyId, address indexed holder, uint256 premium);
    event PausedSet(bool paused);

    constructor(
        IERC20 token_,
        IDryspellEngine engine_,
        UnderwriterVault vault_,
        IWeatherOracle oracle_,
        address owner_,
        uint256 leadTime_,
        uint256 maxHorizon_,
        uint256 minPayout_,
        uint256 oracleFeeBps_
    ) Ownable(owner_) {
        if (
            address(token_) == address(0) || address(engine_) == address(0) || address(vault_) == address(0)
                || address(oracle_) == address(0)
        ) revert ZeroAddress();
        token = token_;
        engine = engine_;
        vault = vault_;
        oracle = oracle_;
        leadTime = leadTime_;
        maxHorizon = maxHorizon_;
        minPayout = minPayout_;
        oracleFeeBps = oracleFeeBps_;
    }

    // ------------------------------------------------------------------ admin
    /// @notice stop (or resume) SELLING new cover. Settlement and refunds are never paused.
    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    // ------------------------------------------------------------------ views
    function getPolicy(uint256 policyId) external view returns (Policy memory p) {
        p = _policies[policyId];
        if (p.holder == address(0)) revert UnknownPolicy();
    }

    function roundIdOf(uint256 tableId, uint256 year) public pure returns (uint256) {
        return ((tableId / 2) << 16) | year;
    }

    /// @notice "stylus" or "solidity-fallback": which engine is pricing and capping this book
    function engineKind() external view returns (string memory) {
        return engine.engineKind();
    }

    /// @notice price a cover exactly as `buy` would, with the timing rules applied
    function quote(uint256 tableId, uint256 year, uint256 trigger, uint256 payout)
        external
        view
        returns (uint256 premium, uint256 pPpm, uint256 sePpm, uint256 ratePpm, bool replay)
    {
        replay = _checkBuyable(tableId, year);
        (premium, pPpm, sePpm, ratePpm) = engine.quote(tableId, trigger, payout);
    }

    // ----------------------------------------------------------------- buying
    /// @notice buy cover. Reverts if the premium has moved above `maxPremium` (slippage guard).
    function buy(uint256 tableId, uint256 year, uint256 trigger, uint256 payout, uint256 maxPremium)
        external
        nonReentrant
        returns (uint256 policyId)
    {
        if (paused) revert PausedError();
        if (payout < minPayout) revert PayoutTooSmall(minPayout);
        bool replay = _checkBuyable(tableId, year);

        (uint256 premium,,,) = engine.quote(tableId, trigger, payout);
        if (premium > maxPremium) revert PremiumAboveMax(premium);

        // exposure is reserved first: reverts if a region/peril or utilisation cap would be breached
        engine.reserve(tableId, payout);

        uint256 rid = roundIdOf(tableId, year);
        roundExposure[rid] += payout;
        roundPolicies[rid] += 1;

        policyId = ++policyCount;
        _policies[policyId] = Policy({
            holder: msg.sender,
            year: uint16(year),
            status: Status.Active,
            trigger: uint32(trigger),
            tableId: uint64(tableId),
            purchasedAt: uint64(block.timestamp),
            payout: uint128(payout),
            premium: uint128(premium)
        });

        token.safeTransferFrom(msg.sender, address(vault), premium);
        emit PolicyBought(policyId, msg.sender, rid, tableId, year, trigger, payout, premium, replay);
    }

    // -------------------------------------------------------------- settlement
    /// @notice settle a policy once its round is final. Anyone may call; the payout always goes to the holder.
    function settle(uint256 policyId) public nonReentrant {
        Policy storage p = _active(policyId);
        uint256 rid = roundIdOf(p.tableId, p.year);
        IWeatherOracle.State st = oracle.roundState(rid);
        if (st != IWeatherOracle.State.Final) revert RoundNotFinal(st);

        (uint256 totalX2, uint256 max3X2) = oracle.finalValues(rid);
        bool drought = p.tableId % 2 == 0;
        uint256 settlementX2 = drought ? totalX2 : max3X2;
        // trigger is in whole mm; settlement values are in units of 0.05 mm
        bool triggered = drought ? settlementX2 <= uint256(p.trigger) * 20 : settlementX2 >= uint256(p.trigger) * 20;

        // effects first
        p.status = triggered ? Status.PaidOut : Status.Expired;
        address holder = p.holder;
        uint256 payout = p.payout;
        uint256 fee = (uint256(p.premium) * oracleFeeBps) / 10_000;

        engine.release(p.tableId, payout);
        if (triggered) vault.payOut(holder, payout);
        if (fee > 0) {
            vault.payOut(address(this), fee);
            token.forceApprove(address(oracle), fee);
            oracle.fundRewards(fee);
        }
        emit PolicySettled(policyId, holder, triggered, triggered ? payout : 0, settlementX2);
    }

    function settleMany(uint256[] calldata policyIds) external {
        for (uint256 i; i < policyIds.length; ++i) {
            settle(policyIds[i]);
        }
    }

    /// @notice return the premium if the oracle voided the round (no report, or a dispute nobody resolved)
    function refund(uint256 policyId) external nonReentrant {
        Policy storage p = _active(policyId);
        uint256 rid = roundIdOf(p.tableId, p.year);
        IWeatherOracle.State st = oracle.roundState(rid);
        if (st != IWeatherOracle.State.Void) revert RoundNotVoid(st);

        p.status = Status.Refunded;
        address holder = p.holder;
        uint256 premium = p.premium;
        engine.release(p.tableId, p.payout);
        vault.payOut(holder, premium);
        emit PolicyRefunded(policyId, holder, premium);
    }

    // --------------------------------------------------------------- internals
    function _active(uint256 policyId) internal view returns (Policy storage p) {
        p = _policies[policyId];
        if (p.holder == address(0)) revert UnknownPolicy();
        if (p.status != Status.Active) revert NotActive(p.status);
    }

    /// @dev validates table, season and timing. Returns whether the round is a testnet replay.
    function _checkBuyable(uint256 tableId, uint256 year) internal view returns (bool replay) {
        if (year < 2020 || year > 2100) revert YearOutOfRange();
        uint256 locSeasonId = tableId / 2;
        if (!oracle.seasonExists(locSeasonId)) revert UnknownSeason();
        (, bool enabled,, uint8 peril) = engine.tableInfo(tableId);
        if (peril != tableId % 2) revert TableMismatch();
        enabled; // a disabled table is rejected by the engine's quote/reserve

        uint256 rid = roundIdOf(tableId, year);
        if (oracle.roundState(rid) != IWeatherOracle.State.None) revert RoundAlreadyReporting();

        replay = oracle.isReplay(rid);
        if (!replay) {
            (uint256 start,) = oracle.seasonWindow(locSeasonId, year);
            if (block.timestamp + leadTime > start) revert TooLate(start - leadTime);
            if (start > block.timestamp + maxHorizon) revert TooEarlyToBuy(start - maxHorizon);
        }
    }
}
