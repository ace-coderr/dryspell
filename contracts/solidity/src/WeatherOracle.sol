// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IWeatherOracle} from "./interfaces/IWeatherOracle.sol";
import {SeasonCalendar} from "./lib/SeasonCalendar.sol";

interface IRoundExposure {
    function roundExposure(uint256 roundId) external view returns (uint256);
}

/// @title WeatherOracle (v1: bonded reporters, dispute window, named resolver)
///
/// HOW IT WORKS
///  1. After a season ends (plus a data-lag), ANY address may post a report by locking a bond.
///     The report carries the raw season readings from BOTH data sources (ERA5 via Open-Meteo and
///     NASA POWER): the season rainfall total and the maximum 3-day rainfall, per source, in 0.1 mm.
///  2. The contract applies the published per-source calibration factors and computes the
///     median (with two sources, the mean) itself. Anyone can recompute it from the public APIs.
///  3. A dispute window opens. Anyone may challenge by locking an equal bond.
///  4. No dispute: the report finalises, the bond is returned and the reporter earns a reward.
///     Disputed: a NAMED RESOLVER rules. The loser forfeits their bond to the winner. If the
///     resolver stays silent past a timeout the round is voided (policies refunded) and both
///     sides lose a small penalty, so disputes are not free griefing.
///
/// V1 LIMITATIONS (stated plainly)
///  - The resolver is a single trusted address. It cannot touch anyone's funds except by choosing
///    who wins a disputed bond, but it CAN choose a wrong result. Decentralised resolution
///    (a bonded committee or an optimistic-oracle style escalation game) is the next step.
///  - Bond size scales with the cover at stake (bondBps of the round's exposure), but a corrupt
///    reporter-resolver pair could still profit if the payout at stake exceeds what they risk.
///  - Calibration factors are fixed by the deployer, per location and season, and cannot change once set.
contract WeatherOracle is IWeatherOracle, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ------------------------------------------------------------------ config
    IERC20 public immutable bondToken;
    /// @notice seconds after season end before data from both sources is reliably published
    uint256 public immutable dataLag;
    /// @notice seconds a proposal can be challenged
    uint256 public immutable disputeWindow;
    /// @notice seconds the resolver has to rule on a dispute
    uint256 public immutable resolverTimeout;
    /// @notice seconds after (season end + dataLag) in which a report must appear, else the round is voided
    uint256 public immutable reportWindow;
    uint256 public immutable minBond;
    /// @notice bond as basis points of the cover at stake in the round
    uint256 public immutable bondBps;
    /// @notice reward paid to a reporter whose report finalises undisputed (capped by the reward pool)
    uint256 public immutable rewardPerRound;
    uint256 public constant VOID_PENALTY_BPS = 1_000; // 10% of each bond when the resolver times out
    uint256 public constant MAX_READING = 10_000_000; // 1,000,000 mm in 0.1 mm units; plain sanity bound
    uint256 public constant PPM = 1_000_000;

    address public resolver;
    address public book;
    bool public bookLocked;
    uint256 public rewardPool;

    // ------------------------------------------------------------------ seasons
    struct Season {
        bool exists;
        uint8 sm;
        uint8 sd;
        uint8 em;
        uint8 ed;
    }

    /// @dev calibration per (locSeasonId, peril): multipliers in ppm applied to each raw reading
    struct Calibration {
        bool set;
        uint32 era5Ppm;
        uint32 powerPpm;
    }

    mapping(uint256 => Season) public seasons;
    mapping(uint256 => mapping(uint8 => Calibration)) public calibration;
    mapping(uint256 => bool) private _replay;
    /// @dev replay rounds get a fresh report window counted from the moment they are opened
    mapping(uint256 => uint256) private _replayOpenedAt;

    // ------------------------------------------------------------------- rounds
    struct Round {
        State state;
        address proposer;
        address disputer;
        uint64 proposedAt;
        uint64 disputedAt;
        uint128 bond;
        uint32 era5Total;
        uint32 era5Max3;
        uint32 powerTotal;
        uint32 powerMax3;
        uint64 totalX2;
        uint64 max3X2;
    }

    mapping(uint256 => Round) private _rounds;

    // ------------------------------------------------------------------- errors
    error ZeroAddress();
    error NotResolver();
    error NotBook();
    error BookAlreadySet();
    error BadSeason();
    error SeasonExists();
    error SeasonUnknown();
    error CalibrationSet();
    error CalibrationMissing();
    error BadYear();
    error ReplayDisabled();
    error SeasonNotOver();
    error NotReportable();
    error TooEarly(uint256 availableAt);
    error NoPolicies();
    error BadReading();
    error BondTooHigh(uint256 required);
    error WrongState(State actual);
    error WindowClosed();
    error WindowOpen(uint256 endsAt);
    error SelfDispute();
    error ResolverTimedOut();
    error ResolverStillTime(uint256 endsAt);

    // ------------------------------------------------------------------- events
    event SeasonDefined(uint256 indexed locSeasonId, uint8 sm, uint8 sd, uint8 em, uint8 ed);
    event CalibrationDefined(uint256 indexed locSeasonId, uint8 peril, uint32 era5Ppm, uint32 powerPpm);
    event ReplayOpened(uint256 indexed roundId);
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
    event Disputed(uint256 indexed roundId, address indexed disputer, uint256 bond);
    event Finalized(uint256 indexed roundId, uint256 totalX2, uint256 max3X2, bool disputed, bool replay);
    event Resolved(
        uint256 indexed roundId,
        bool proposalUpheld,
        uint32 era5Total,
        uint32 era5Max3,
        uint32 powerTotal,
        uint32 powerMax3
    );
    event Voided(uint256 indexed roundId, string reason, bool replay);
    event RewardFunded(address indexed from, uint256 amount, uint256 pool);
    event ResolverSet(address indexed resolver);
    event BookSet(address indexed book);

    constructor(
        IERC20 bondToken_,
        address owner_,
        address resolver_,
        uint256 dataLag_,
        uint256 disputeWindow_,
        uint256 resolverTimeout_,
        uint256 reportWindow_,
        uint256 minBond_,
        uint256 bondBps_,
        uint256 rewardPerRound_
    ) Ownable(owner_) {
        if (address(bondToken_) == address(0) || resolver_ == address(0)) revert ZeroAddress();
        bondToken = bondToken_;
        resolver = resolver_;
        dataLag = dataLag_;
        disputeWindow = disputeWindow_;
        resolverTimeout = resolverTimeout_;
        reportWindow = reportWindow_;
        minBond = minBond_;
        bondBps = bondBps_;
        rewardPerRound = rewardPerRound_;
        emit ResolverSet(resolver_);
    }

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    // ------------------------------------------------------------- owner wiring
    function setBook(address book_) external onlyOwner {
        if (bookLocked) revert BookAlreadySet();
        if (book_ == address(0)) revert ZeroAddress();
        book = book_;
        bookLocked = true;
        emit BookSet(book_);
    }

    function setResolver(address resolver_) external onlyOwner {
        if (resolver_ == address(0)) revert ZeroAddress();
        resolver = resolver_;
        emit ResolverSet(resolver_);
    }

    /// @notice define a season window (set once; cannot be changed after policies reference it)
    function defineSeason(uint256 locSeasonId, uint8 sm, uint8 sd, uint8 em, uint8 ed) external onlyOwner {
        if (seasons[locSeasonId].exists) revert SeasonExists();
        if (sm < 1 || sm > 12 || em < 1 || em > 12 || sd < 1 || sd > 31 || ed < 1 || ed > 31) revert BadSeason();
        // the window must be well-formed in a non-leap and a leap year
        SeasonCalendar.window(2027, sm, sd, em, ed);
        seasons[locSeasonId] = Season(true, sm, sd, em, ed);
        emit SeasonDefined(locSeasonId, sm, sd, em, ed);
    }

    /// @notice set the per-source calibration multipliers (ppm) for a season and peril (set once)
    function defineCalibration(uint256 locSeasonId, uint8 peril, uint32 era5Ppm, uint32 powerPpm) external onlyOwner {
        if (!seasons[locSeasonId].exists) revert SeasonUnknown();
        if (peril > 1 || era5Ppm == 0 || powerPpm == 0) revert BadSeason();
        if (calibration[locSeasonId][peril].set) revert CalibrationSet();
        calibration[locSeasonId][peril] = Calibration(true, era5Ppm, powerPpm);
        emit CalibrationDefined(locSeasonId, peril, era5Ppm, powerPpm);
    }

    /// @notice (test networks only, see replayAllowed) open a completed historical season so a policy
    ///         can be bought and settled end-to-end in a demo. Replay rounds are labelled "Replay"
    ///         in every event and in the app.
    function openReplay(uint256 locSeasonId, uint256 year) external onlyOwner {
        if (!replayAllowed()) revert ReplayDisabled();
        uint256 roundId = _roundId(locSeasonId, year);
        (, uint256 end) = _window(locSeasonId, year);
        if (block.timestamp < end + dataLag) revert SeasonNotOver();
        if (_rounds[roundId].state != State.None) revert WrongState(_rounds[roundId].state);
        _replay[roundId] = true;
        _replayOpenedAt[roundId] = block.timestamp;
        emit ReplayOpened(roundId);
    }

    // ------------------------------------------------------------------- views
    /// @notice Replay rounds exist for demos only and are hard-wired to test networks by chain id:
    ///         Arbitrum Sepolia (421614), Robinhood Chain testnet (46630) and local dev chains
    ///         (31337, 1337). There is no owner switch: on any other chain, including Arbitrum One
    ///         (42161), `openReplay` always reverts.
    function replayAllowed() public view returns (bool) {
        uint256 id = block.chainid;
        return id == 421614 || id == 46630 || id == 31337 || id == 1337;
    }

    function roundId(uint256 locSeasonId, uint256 year) external pure returns (uint256) {
        return _roundId(locSeasonId, year);
    }

    function roundState(uint256 id) external view returns (State) {
        return _rounds[id].state;
    }

    function isReplay(uint256 id) external view returns (bool) {
        return _replay[id];
    }

    function seasonExists(uint256 locSeasonId) external view returns (bool) {
        return seasons[locSeasonId].exists;
    }

    function seasonWindow(uint256 locSeasonId, uint256 year) external view returns (uint256 start, uint256 end) {
        return _window(locSeasonId, year);
    }

    function getRound(uint256 id) external view returns (Round memory) {
        return _rounds[id];
    }

    /// @return when the current proposal can be finalised (0 if none is open)
    function challengeEndsAt(uint256 id) external view returns (uint256) {
        Round storage r = _rounds[id];
        return r.state == State.Proposed ? uint256(r.proposedAt) + disputeWindow : 0;
    }

    /// @return when the resolver's time runs out (0 if no dispute is open)
    function resolverDeadline(uint256 id) external view returns (uint256) {
        Round storage r = _rounds[id];
        return r.state == State.Disputed ? uint256(r.disputedAt) + resolverTimeout : 0;
    }

    /// @return earliest time a report can be posted
    function reportableFrom(uint256 locSeasonId, uint256 year) external view returns (uint256) {
        (, uint256 end) = _window(locSeasonId, year);
        return end + dataLag;
    }

    /// @return last second at which a report can still be posted for this round
    function reportDeadline(uint256 id) external view returns (uint256) {
        (, uint256 end) = _window(id >> 16, id & 0xFFFF);
        return _reportDeadline(id, end);
    }

    function requiredBond(uint256 id) public view returns (uint256) {
        uint256 scaled = book == address(0) ? 0 : (IRoundExposure(book).roundExposure(id) * bondBps) / 10_000;
        return scaled > minBond ? scaled : minBond;
    }

    function finalValues(uint256 id) external view returns (uint256, uint256) {
        Round storage r = _rounds[id];
        if (r.state != State.Final) revert WrongState(r.state);
        return (r.totalX2, r.max3X2);
    }

    /// @notice what the settlement values would be for a set of readings (pure convenience for UIs and verifiers)
    function previewSettlement(uint256 locSeasonId, uint32 era5Total, uint32 era5Max3, uint32 powerTotal, uint32 powerMax3)
        public
        view
        returns (uint256 totalX2, uint256 max3X2)
    {
        Calibration memory d = calibration[locSeasonId][0];
        Calibration memory f = calibration[locSeasonId][1];
        if (!d.set || !f.set) revert CalibrationMissing();
        totalX2 = (uint256(era5Total) * d.era5Ppm + uint256(powerTotal) * d.powerPpm) / PPM;
        max3X2 = (uint256(era5Max3) * f.era5Ppm + uint256(powerMax3) * f.powerPpm) / PPM;
    }

    // ------------------------------------------------------------------ rewards
    function fundRewards(uint256 amount) external nonReentrant {
        bondToken.safeTransferFrom(msg.sender, address(this), amount);
        rewardPool += amount;
        emit RewardFunded(msg.sender, amount, rewardPool);
    }

    // ------------------------------------------------------------------ reporting
    /// @notice post season readings from both sources and lock a bond. Permissionless.
    /// @param maxBond the most the caller is willing to lock (the bond grows with cover sold)
    function propose(
        uint256 locSeasonId,
        uint256 year,
        uint32 era5Total,
        uint32 era5Max3,
        uint32 powerTotal,
        uint32 powerMax3,
        uint256 maxBond
    ) external nonReentrant {
        uint256 id = _roundId(locSeasonId, year);
        Round storage r = _rounds[id];
        if (r.state != State.None) revert WrongState(r.state);
        _requireReportable(id, locSeasonId, year);
        _checkReadings(era5Total, era5Max3);
        _checkReadings(powerTotal, powerMax3);
        // make sure the calibration exists before anything is locked
        previewSettlement(locSeasonId, era5Total, era5Max3, powerTotal, powerMax3);
        if (book == address(0) || IRoundExposure(book).roundExposure(id) == 0) revert NoPolicies();

        uint256 bond = requiredBond(id);
        if (bond > maxBond) revert BondTooHigh(bond);

        r.state = State.Proposed;
        r.proposer = msg.sender;
        r.proposedAt = uint64(block.timestamp);
        r.bond = uint128(bond);
        r.era5Total = era5Total;
        r.era5Max3 = era5Max3;
        r.powerTotal = powerTotal;
        r.powerMax3 = powerMax3;
        bondToken.safeTransferFrom(msg.sender, address(this), bond);
        emit Proposed(id, msg.sender, era5Total, era5Max3, powerTotal, powerMax3, bond, _replay[id]);
    }

    function _requireReportable(uint256 id, uint256 locSeasonId, uint256 year) internal view {
        (, uint256 end) = _window(locSeasonId, year);
        if (block.timestamp < end + dataLag) revert TooEarly(end + dataLag);
        if (block.timestamp > _reportDeadline(id, end)) revert WindowClosed();
    }

    /// @notice challenge a proposal inside the dispute window by locking an equal bond
    function dispute(uint256 id) external nonReentrant {
        Round storage r = _rounds[id];
        if (r.state != State.Proposed) revert WrongState(r.state);
        if (block.timestamp >= uint256(r.proposedAt) + disputeWindow) revert WindowClosed();
        if (msg.sender == r.proposer) revert SelfDispute();
        r.state = State.Disputed;
        r.disputer = msg.sender;
        r.disputedAt = uint64(block.timestamp);
        bondToken.safeTransferFrom(msg.sender, address(this), r.bond);
        emit Disputed(id, msg.sender, r.bond);
    }

    /// @notice finalise an undisputed proposal once the window has passed. Anyone may call.
    function finalize(uint256 id) external nonReentrant {
        Round storage r = _rounds[id];
        if (r.state != State.Proposed) revert WrongState(r.state);
        uint256 endsAt = uint256(r.proposedAt) + disputeWindow;
        if (block.timestamp < endsAt) revert WindowOpen(endsAt);
        _setFinal(id, r);
        emit Finalized(id, r.totalX2, r.max3X2, false, _replay[id]);

        uint256 reward = rewardPool < rewardPerRound ? rewardPool : rewardPerRound;
        rewardPool -= reward;
        bondToken.safeTransfer(r.proposer, uint256(r.bond) + reward);
    }

    /// @notice the resolver rules on a dispute. If the proposal is not upheld the resolver supplies
    ///         the readings that become final. The loser's bond goes to the winner.
    function resolve(
        uint256 id,
        bool proposalUpheld,
        uint32 era5Total,
        uint32 era5Max3,
        uint32 powerTotal,
        uint32 powerMax3
    ) external onlyResolver nonReentrant {
        Round storage r = _rounds[id];
        if (r.state != State.Disputed) revert WrongState(r.state);
        if (block.timestamp > uint256(r.disputedAt) + resolverTimeout) revert ResolverTimedOut();

        if (!proposalUpheld) {
            _checkReadings(era5Total, era5Max3);
            _checkReadings(powerTotal, powerMax3);
            r.era5Total = era5Total;
            r.era5Max3 = era5Max3;
            r.powerTotal = powerTotal;
            r.powerMax3 = powerMax3;
        }
        _setFinal(id, r);
        emit Resolved(id, proposalUpheld, r.era5Total, r.era5Max3, r.powerTotal, r.powerMax3);
        emit Finalized(id, r.totalX2, r.max3X2, true, _replay[id]);

        uint256 pot = 2 * uint256(r.bond);
        bondToken.safeTransfer(proposalUpheld ? r.proposer : r.disputer, pot);
    }

    /// @notice anyone may void a dispute the resolver did not rule on in time. Both sides lose a
    ///         small penalty (to the reward pool) so disputing is never a free way to stall payouts.
    function voidDisputed(uint256 id) external nonReentrant {
        Round storage r = _rounds[id];
        if (r.state != State.Disputed) revert WrongState(r.state);
        uint256 endsAt = uint256(r.disputedAt) + resolverTimeout;
        if (block.timestamp <= endsAt) revert ResolverStillTime(endsAt);
        r.state = State.Void;
        uint256 bond = r.bond;
        uint256 penalty = (bond * VOID_PENALTY_BPS) / 10_000;
        rewardPool += 2 * penalty;
        bondToken.safeTransfer(r.proposer, bond - penalty);
        bondToken.safeTransfer(r.disputer, bond - penalty);
        emit Voided(id, "resolver timeout", _replay[id]);
    }

    /// @inheritdoc IWeatherOracle
    function voidUnreported(uint256 id) external {
        Round storage r = _rounds[id];
        if (r.state != State.None) revert WrongState(r.state);
        uint256 locSeasonId = id >> 16;
        uint256 year = id & 0xFFFF;
        (, uint256 end) = _window(locSeasonId, year);
        uint256 deadline = _reportDeadline(id, end);
        if (block.timestamp <= deadline) revert TooEarly(deadline + 1);
        if (book == address(0) || IRoundExposure(book).roundExposure(id) == 0) revert NoPolicies();
        r.state = State.Void;
        emit Voided(id, "no report", _replay[id]);
    }

    // ---------------------------------------------------------------- internals
    function _reportDeadline(uint256 id, uint256 seasonEnd) internal view returns (uint256) {
        uint256 opened = _replayOpenedAt[id];
        if (opened != 0) return opened + reportWindow;
        return seasonEnd + dataLag + reportWindow;
    }

    function _roundId(uint256 locSeasonId, uint256 year) internal pure returns (uint256) {
        if (year < 2020 || year > 2100) revert BadYear();
        if (locSeasonId > type(uint48).max) revert BadSeason();
        return (locSeasonId << 16) | year;
    }

    function _window(uint256 locSeasonId, uint256 year) internal view returns (uint256, uint256) {
        Season memory s = seasons[locSeasonId];
        if (!s.exists) revert SeasonUnknown();
        if (year < 2020 || year > 2100) revert BadYear();
        return SeasonCalendar.window(year, s.sm, s.sd, s.em, s.ed);
    }

    /// @dev physically a 3-day maximum cannot exceed the season total
    function _checkReadings(uint32 total, uint32 max3) internal pure {
        if (total > MAX_READING || max3 > total) revert BadReading();
    }

    function _setFinal(uint256 id, Round storage r) internal {
        (uint256 t, uint256 m) = previewSettlement(id >> 16, r.era5Total, r.era5Max3, r.powerTotal, r.powerMax3);
        r.totalX2 = uint64(t);
        r.max3X2 = uint64(m);
        r.state = State.Final;
    }
}
