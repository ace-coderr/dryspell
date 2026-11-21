// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IDryspellEngine} from "./interfaces/IDryspellEngine.sol";

/// @title UnderwriterVault
/// @notice ERC-4626 pool of TestUSD that backs every policy. Underwriters deposit and receive
///         shares; premiums flow in (raising the share price = yield) and payouts flow out
///         (lowering it). Cover is fully collateralised: assets that back active policies
///         (the engine's total exposure) cannot be withdrawn.
///
/// Design choices:
///  - Shares are NON-TRANSFERABLE and deposits must be for yourself. That closes the
///    "dust deposit resets a victim's lock-up" griefing path and stops lock-up evasion by transfer.
///  - A minimum holding period after each deposit blunts just-in-time deposits that would
///    otherwise skim a premium that was priced for a risk the depositor never carried.
///  - The ERC-4626 virtual-share offset (decimals offset 3) neutralises the donation/inflation attack.
contract UnderwriterVault is ERC4626, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IDryspellEngine public immutable engine;
    /// @notice seconds a depositor must wait after their latest deposit before withdrawing
    uint256 public immutable minHold;

    address public book;
    bool public bookLocked;

    mapping(address => uint256) public depositedAt;

    error NotBook();
    error BookAlreadySet();
    error ZeroAddress();
    error ReceiverMustBeCaller();
    error SharesNotTransferable();
    error CallerMustBeOwner();
    error HoldPeriodActive(uint256 withdrawableAt);

    event BookSet(address indexed book);
    event PaidOut(address indexed to, uint256 amount);

    constructor(IERC20 asset_, IDryspellEngine engine_, uint256 minHold_, address owner_)
        ERC20("Dryspell Underwriter Share", "dryUW")
        ERC4626(asset_)
        Ownable(owner_)
    {
        if (address(engine_) == address(0)) revert ZeroAddress();
        engine = engine_;
        minHold = minHold_;
    }

    // ------------------------------------------------------------- wiring
    /// @notice One-time wiring of the policy book, the only address allowed to pull payouts.
    function setBook(address book_) external onlyOwner {
        if (bookLocked) revert BookAlreadySet();
        if (book_ == address(0)) revert ZeroAddress();
        book = book_;
        bookLocked = true;
        emit BookSet(book_);
    }

    modifier onlyBook() {
        if (msg.sender != book) revert NotBook();
        _;
    }

    /// @notice Move assets out of the pool: claim payouts, premium refunds and oracle fees.
    function payOut(address to, uint256 amount) external onlyBook nonReentrant {
        IERC20(asset()).safeTransfer(to, amount);
        emit PaidOut(to, amount);
    }

    // -------------------------------------------------------------- views
    /// @notice assets that cannot be withdrawn because they back active policies
    function lockedAssets() public view returns (uint256) {
        uint256 total = totalAssets();
        uint256 exposure = engine.totalExposure();
        return exposure > total ? total : exposure;
    }

    /// @notice assets that can currently leave the pool
    function freeAssets() public view returns (uint256) {
        return totalAssets() - lockedAssets();
    }

    /// @notice exposure / assets in basis points (0 when empty)
    function utilizationBps() external view returns (uint256) {
        uint256 total = totalAssets();
        if (total == 0) return 0;
        return (engine.totalExposure() * 10_000) / total;
    }

    /// @notice timestamp from which `owner_` may withdraw
    function withdrawableAt(address owner_) public view returns (uint256) {
        uint256 d = depositedAt[owner_];
        return d == 0 ? 0 : d + minHold;
    }

    function maxWithdraw(address owner_) public view override returns (uint256) {
        if (block.timestamp < withdrawableAt(owner_)) return 0;
        uint256 own = _convertToAssets(balanceOf(owner_), Math.Rounding.Floor);
        uint256 free = freeAssets();
        return own < free ? own : free;
    }

    function maxRedeem(address owner_) public view override returns (uint256) {
        if (block.timestamp < withdrawableAt(owner_)) return 0;
        uint256 shares = balanceOf(owner_);
        uint256 freeShares = _convertToShares(freeAssets(), Math.Rounding.Floor);
        return shares < freeShares ? shares : freeShares;
    }

    function _decimalsOffset() internal pure override returns (uint8) {
        return 3;
    }

    // ------------------------------------------------- ERC-4626 hooks
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        if (caller != receiver) revert ReceiverMustBeCaller();
        depositedAt[receiver] = block.timestamp;
        super._deposit(caller, receiver, assets, shares);
    }

    function _withdraw(address caller, address receiver, address owner_, uint256 assets, uint256 shares)
        internal
        override
        nonReentrant
    {
        if (caller != owner_) revert CallerMustBeOwner();
        super._withdraw(caller, receiver, owner_, assets, shares);
    }

    /// @dev shares can be minted and burned but never moved between accounts
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) revert SharesNotTransferable();
        super._update(from, to, value);
    }
}
