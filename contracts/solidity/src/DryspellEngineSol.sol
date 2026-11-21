// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IDryspellEngine} from "./interfaces/IDryspellEngine.sol";

interface IVaultAssets {
    function totalAssets() external view returns (uint256);
}

/// @title DryspellEngineSol - SOLIDITY FALLBACK ENGINE (not the Stylus engine)
/// @notice A line-for-line port of the Rust/Stylus engine in `contracts/stylus` with the identical
///         ABI, errors, events and arithmetic (including the u128 overflow boundaries), so the policy
///         book can use either one. `engineKind()` returns "solidity-fallback" so nobody can mistake
///         it for the Stylus build. It exists because Stylus activation was paused on Arbitrum
///         Sepolia when this project was built; see the repository README.
///         Parity with the Rust engine is checked by test vectors generated from the Rust code.
///
/// Pricing:  premium = ceil(payout * rate / 1e6)
///           rate    = ceil((p + max(ceil(k * se), floor)) * (1 + loading))
/// Solvency: per-(region, peril) and total exposure caps measured against the vault's totalAssets().
contract DryspellEngineSol is IDryspellEngine {
    // ------------------------------------------------------------------ events
    event TableLoaded(uint256 indexed tableId, uint8 region, uint8 peril, uint256 points);
    event TableEnabled(uint256 indexed tableId, bool enabled);
    event ParamsSet(uint256 marginKBps, uint256 floorPpm, uint256 loadingBps, uint256 maxRatePpm, uint256 maxUtilBps);
    event CapSet(uint8 region, uint8 peril, uint256 capBps);
    event BookSet(address book);
    event VaultSet(address vault);
    event Reserved(uint256 indexed tableId, uint256 payout, uint256 regionPerilExposure, uint256 totalExposure);
    event Released(uint256 indexed tableId, uint256 payout, uint256 regionPerilExposure, uint256 totalExposure);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    // ----------------------------------------------------------------- storage
    uint256 internal constant PPM = 1_000_000;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant MAX_POINTS = 32;
    uint256 internal constant U128_MAX = type(uint128).max;

    struct Point {
        uint32 level;
        uint32 p;
        uint32 se;
    }

    struct Table {
        bool exists;
        bool enabled;
        uint8 region;
        uint8 peril;
        Point[] pts;
    }

    address internal _owner;
    address internal _pendingOwner;
    address internal _book;
    address internal _vault;

    uint256 internal _marginKBps;
    uint256 internal _floorPpm;
    uint256 internal _loadingBps;
    uint256 internal _maxRatePpm;
    uint256 internal _maxUtilBps;

    uint256 internal _totalExposure;
    mapping(uint256 => uint256) internal _exposure; // key = (region << 8) | peril
    mapping(uint256 => uint256) internal _capBps;
    mapping(uint256 => Table) internal _tables;

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        _owner = owner_;
        // identical launch defaults to the Stylus constructor
        _setParams(15_000, 2_000, 2_500, 700_000, 8_000);
        emit OwnershipTransferred(address(0), owner_);
    }

    modifier onlyOwner() {
        if (msg.sender != _owner) revert NotOwner();
        _;
    }

    modifier onlyBook() {
        if (_book == address(0) || msg.sender != _book) revert NotBook();
        _;
    }

    // ------------------------------------------------------------------- views
    function engineKind() external pure returns (string memory) {
        return "solidity-fallback";
    }

    function owner() external view returns (address) {
        return _owner;
    }

    function pendingOwner() external view returns (address) {
        return _pendingOwner;
    }

    function book() external view returns (address) {
        return _book;
    }

    function vault() external view returns (address) {
        return _vault;
    }

    function params() external view returns (uint256, uint256, uint256, uint256, uint256) {
        return (_marginKBps, _floorPpm, _loadingBps, _maxRatePpm, _maxUtilBps);
    }

    function totalExposure() external view returns (uint256) {
        return _totalExposure;
    }

    function exposureOf(uint8 region, uint8 peril) external view returns (uint256) {
        return _exposure[_key(region, peril)];
    }

    function capBpsOf(uint8 region, uint8 peril) external view returns (uint256) {
        return _capBps[_key(region, peril)];
    }

    function tableInfo(uint256 tableId) external view returns (bool, bool, uint8, uint8) {
        Table storage t = _tables[tableId];
        return (t.exists, t.enabled, t.region, t.peril);
    }

    function tablePoints(uint256 tableId) external view returns (uint32[] memory lv, uint32[] memory p, uint32[] memory se) {
        Table storage t = _table(tableId);
        uint256 n = t.pts.length;
        lv = new uint32[](n);
        p = new uint32[](n);
        se = new uint32[](n);
        for (uint256 i; i < n; ++i) {
            lv[i] = t.pts[i].level;
            p[i] = t.pts[i].p;
            se[i] = t.pts[i].se;
        }
    }

    function quote(uint256 tableId, uint256 triggerMm, uint256 payout)
        external
        view
        returns (uint256, uint256, uint256, uint256)
    {
        Table storage t = _table(tableId);
        if (!t.enabled) revert TableDisabled();
        // argument evaluation order matches the Rust engine: trigger, then payout
        uint32 trig = _toU32(triggerMm);
        uint256 pay = _toU128(payout);
        if (pay == 0) revert ZeroPayout();
        (uint256 p, uint256 se) = _interpolate(t, trig);
        uint256 rate = _rate(p, se);
        uint256 prem = _ceilDiv(_mul(pay, rate), PPM);
        return (prem, p, se, rate);
    }

    function headroom(uint256 tableId) external view returns (uint256) {
        Table storage t = _table(tableId);
        uint256 capital = _capital();
        uint256 key = _key(t.region, t.peril);
        uint256 rp = _exposure[key];
        uint256 total = _totalExposure;
        uint256 rpMax = _satMul(capital, _capBps[key]) / BPS;
        uint256 tMax = _satMul(capital, _maxUtilBps) / BPS;
        uint256 a = rpMax > rp ? rpMax - rp : 0;
        uint256 b = tMax > total ? tMax - total : 0;
        return a < b ? a : b;
    }

    // --------------------------------------------------------- policy book only
    function reserve(uint256 tableId, uint256 payout) external onlyBook {
        Table storage t = _table(tableId);
        if (!t.enabled) revert TableDisabled();
        uint256 amount = _toU128(payout);
        uint256 key = _key(t.region, t.peril);
        uint256 capital = _capital();
        // solvency check, same order as solvency::check_reserve
        if (amount == 0) revert ZeroPayout();
        if (capital == 0) revert NoCapital();
        uint256 cap = _capBps[key];
        if (cap == 0) revert NoCap();
        uint256 newRp = _add(_exposure[key], amount);
        uint256 newTotal = _add(_totalExposure, amount);
        uint256 lhsRp = _mul(newRp, BPS);
        uint256 rhsRp = _mul(capital, cap);
        if (lhsRp > rhsRp) revert CapBreached(1);
        uint256 lhsT = _mul(newTotal, BPS);
        uint256 rhsT = _mul(capital, _maxUtilBps);
        if (lhsT > rhsT) revert CapBreached(2);
        _exposure[key] = newRp;
        _totalExposure = newTotal;
        emit Reserved(tableId, payout, newRp, newTotal);
    }

    function release(uint256 tableId, uint256 payout) external onlyBook {
        Table storage t = _table(tableId);
        uint256 amount = _toU128(payout);
        if (amount == 0) revert ZeroPayout();
        uint256 key = _key(t.region, t.peril);
        uint256 rp = _exposure[key];
        uint256 total = _totalExposure;
        if (amount > rp || amount > total) revert ReleaseTooLarge();
        _exposure[key] = rp - amount;
        _totalExposure = total - amount;
        emit Released(tableId, payout, rp - amount, total - amount);
    }

    // ------------------------------------------------------------------- owner
    function setBook(address book_) external onlyOwner {
        if (book_ == address(0)) revert ZeroAddress();
        _book = book_;
        emit BookSet(book_);
    }

    function setVault(address vault_) external onlyOwner {
        if (vault_ == address(0)) revert ZeroAddress();
        _vault = vault_;
        emit VaultSet(vault_);
    }

    function setPricingParams(
        uint256 marginKBps,
        uint256 floorPpm,
        uint256 loadingBps,
        uint256 maxRatePpm,
        uint256 maxUtilBps
    ) external onlyOwner {
        _setParams(marginKBps, floorPpm, loadingBps, maxRatePpm, maxUtilBps);
    }

    function setCap(uint8 region, uint8 peril, uint256 capBps) external onlyOwner {
        if (peril > 1 || capBps > BPS) revert BadParams();
        _capBps[_key(region, peril)] = capBps;
        emit CapSet(region, peril, capBps);
    }

    function loadTable(
        uint256 tableId,
        uint8 region,
        uint8 peril,
        uint32[] calldata levels,
        uint32[] calldata pPpm,
        uint32[] calldata sePpm
    ) external onlyOwner {
        if (peril > 1) revert BadTable(2);
        uint256 n = levels.length;
        if (pPpm.length != n || sePpm.length != n) revert BadTable(8);
        _validate(peril, levels, pPpm, sePpm);

        Table storage t = _tables[tableId];
        if (t.exists && (t.region != region || t.peril != peril)) revert BadTable(9);

        delete t.pts;
        for (uint256 i; i < n; ++i) {
            t.pts.push(Point(levels[i], pPpm[i], sePpm[i]));
        }
        if (!t.exists) {
            t.exists = true;
            t.enabled = true;
            t.region = region;
            t.peril = peril;
        }
        emit TableLoaded(tableId, region, peril, n);
    }

    function setTableEnabled(uint256 tableId, bool enabled) external onlyOwner {
        Table storage t = _tables[tableId];
        if (!t.exists) revert UnknownTable();
        t.enabled = enabled;
        emit TableEnabled(tableId, enabled);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        _pendingOwner = newOwner;
        emit OwnershipTransferStarted(_owner, newOwner);
    }

    function acceptOwnership() external {
        address pending = _pendingOwner;
        if (pending == address(0) || msg.sender != pending) revert NotPendingOwner();
        address previous = _owner;
        _owner = pending;
        _pendingOwner = address(0);
        emit OwnershipTransferred(previous, pending);
    }

    // ---------------------------------------------------------------- internals
    function _key(uint8 region, uint8 peril) internal pure returns (uint256) {
        return (uint256(region) << 8) | uint256(peril);
    }

    function _table(uint256 id) internal view returns (Table storage t) {
        t = _tables[id];
        if (!t.exists) revert UnknownTable();
    }

    function _toU32(uint256 x) internal pure returns (uint32) {
        if (x > type(uint32).max) revert OutOfRange();
        return uint32(x);
    }

    function _toU128(uint256 x) internal pure returns (uint256) {
        if (x > U128_MAX) revert AmountTooLarge();
        return x;
    }

    // u128-bounded checked arithmetic, mirroring Rust's checked_add / checked_mul on u128
    function _add(uint256 a, uint256 b) internal pure returns (uint256 c) {
        c = a + b;
        if (c > U128_MAX) revert MathOverflow();
    }

    function _mul(uint256 a, uint256 b) internal pure returns (uint256 c) {
        if (a != 0 && b > U128_MAX / a) revert MathOverflow();
        c = a * b;
    }

    function _satMul(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a != 0 && b > U128_MAX / a) return U128_MAX;
        return a * b;
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a / b + (a % b == 0 ? 0 : 1);
    }

    function _capital() internal view returns (uint256) {
        address v = _vault;
        if (v == address(0)) revert NoCapital();
        (bool ok, bytes memory ret) = v.staticcall(abi.encodeCall(IVaultAssets.totalAssets, ()));
        if (!ok || ret.length < 32) revert VaultCallFailed();
        return _toU128(abi.decode(ret, (uint256)));
    }

    function _setParams(uint256 k, uint256 floorPpm, uint256 loading, uint256 maxRate, uint256 maxUtil) internal {
        if (
            k > type(uint32).max || floorPpm > type(uint32).max || loading > type(uint32).max
                || maxRate > type(uint32).max || maxUtil > type(uint32).max
        ) revert BadParams();
        bool valid = maxRate > 0 && maxRate < PPM && loading <= 100_000 && k <= 1_000_000 && floorPpm < PPM;
        if (!valid || maxUtil == 0 || maxUtil > BPS) revert BadParams();
        _marginKBps = k;
        _floorPpm = floorPpm;
        _loadingBps = loading;
        _maxRatePpm = maxRate;
        _maxUtilBps = maxUtil;
        emit ParamsSet(k, floorPpm, loading, maxRate, maxUtil);
    }

    function _validate(uint8 peril, uint32[] calldata lv, uint32[] calldata p, uint32[] calldata se) internal pure {
        uint256 n = lv.length;
        if (n < 2) revert BadTable(1);
        if (n > MAX_POINTS) revert BadTable(7);
        for (uint256 i; i < n; ++i) {
            if (p[i] == 0) revert BadTable(6);
            if (uint256(p[i]) > PPM || uint256(se[i]) > PPM) revert BadTable(5);
            if (i > 0) {
                bool ok = peril == 0 ? lv[i] > lv[i - 1] : lv[i] < lv[i - 1];
                if (!ok) revert BadTable(3);
                if (p[i] < p[i - 1]) revert BadTable(4);
            }
        }
    }

    /// Linear interpolation of (p, se), rounded up; see pricing::interpolate.
    function _interpolate(Table storage t, uint32 level) internal view returns (uint256, uint256) {
        uint256 n = t.pts.length;
        if (n < 2) revert OutOfRange();
        bool drought = t.peril == 0;
        uint32 first = t.pts[0].level;
        uint32 last = t.pts[n - 1].level;
        bool inside = drought ? (level >= first && level <= last) : (level <= first && level >= last);
        if (!inside) revert OutOfRange();
        for (uint256 i; i + 1 < n; ++i) {
            Point memory a = t.pts[i];
            Point memory b = t.pts[i + 1];
            bool within = drought ? (level >= a.level && level <= b.level) : (level <= a.level && level >= b.level);
            if (!within) continue;
            uint256 span = a.level > b.level ? a.level - b.level : b.level - a.level;
            uint256 off = level > a.level ? level - a.level : a.level - level;
            return (_lerp(a.p, b.p, off, span), _lerp(a.se, b.se, off, span));
        }
        revert OutOfRange();
    }

    function _lerp(uint256 x, uint256 y, uint256 off, uint256 span) internal pure returns (uint256) {
        if (y >= x) return x + _ceilDiv((y - x) * off, span);
        // decreasing: round the subtracted part down so the result rounds up
        return x - ((x - y) * off) / span;
    }

    function _rate(uint256 p, uint256 se) internal view returns (uint256) {
        uint256 margin = _ceilDiv(se * _marginKBps, BPS);
        if (margin < _floorPpm) margin = _floorPpm;
        uint256 raw = _add(p, margin);
        uint256 loaded = _mul(raw, BPS + _loadingBps);
        uint256 rate = _ceilDiv(loaded, BPS);
        if (rate > _maxRatePpm) revert RateTooHigh();
        return rate;
    }
}
