// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice ABI shared by the Stylus (Rust) engine and the Solidity fallback engine.
///         The policy book only ever talks to this interface, so either engine can be wired in.
interface IDryspellEngine {
    // ---- errors (identical in both implementations)
    error NotOwner();
    error NotPendingOwner();
    error NotBook();
    error ZeroAddress();
    error BadParams();
    /// code: 1 too few points, 2 bad peril, 3 levels not monotone, 4 probability not monotone,
    /// 5 probability too large, 6 zero probability, 7 too many points, 8 length mismatch,
    /// 9 region/peril changed on reload
    error BadTable(uint8 code);
    error UnknownTable();
    error TableDisabled();
    error OutOfRange();
    error RateTooHigh();
    error ZeroPayout();
    error AmountTooLarge();
    /// which: 1 region/peril cap, 2 total utilization cap
    error CapBreached(uint8 which);
    error NoCapital();
    error NoCap();
    error ReleaseTooLarge();
    error VaultCallFailed();
    error MathOverflow();
    /// the book and vault wiring can be set exactly once
    error AlreadySet();

    // ---- views
    /// @return "stylus" for the Rust/WASM engine, "solidity-fallback" for the EVM port
    function engineKind() external view returns (string memory);
    function owner() external view returns (address);
    function pendingOwner() external view returns (address);
    function book() external view returns (address);
    function vault() external view returns (address);
    /// @return marginKBps floorPpm loadingBps maxRatePpm maxUtilBps
    function params() external view returns (uint256, uint256, uint256, uint256, uint256);
    function totalExposure() external view returns (uint256);
    function exposureOf(uint8 region, uint8 peril) external view returns (uint256);
    function capBpsOf(uint8 region, uint8 peril) external view returns (uint256);
    /// @return exists enabled region peril
    function tableInfo(uint256 tableId) external view returns (bool, bool, uint8, uint8);
    function tablePoints(uint256 tableId) external view returns (uint32[] memory, uint32[] memory, uint32[] memory);
    /// @return premium pPpm sePpm ratePpm
    function quote(uint256 tableId, uint256 triggerMm, uint256 payout)
        external
        view
        returns (uint256, uint256, uint256, uint256);
    function headroom(uint256 tableId) external view returns (uint256);

    // ---- book-only
    function reserve(uint256 tableId, uint256 payout) external;
    function release(uint256 tableId, uint256 payout) external;

    // ---- owner
    function setBook(address book_) external;
    function setVault(address vault_) external;
    function setPricingParams(
        uint256 marginKBps,
        uint256 floorPpm,
        uint256 loadingBps,
        uint256 maxRatePpm,
        uint256 maxUtilBps
    ) external;
    function setCap(uint8 region, uint8 peril, uint256 capBps) external;
    function loadTable(
        uint256 tableId,
        uint8 region,
        uint8 peril,
        uint32[] calldata levels,
        uint32[] calldata pPpm,
        uint32[] calldata sePpm
    ) external;
    function setTableEnabled(uint256 tableId, bool enabled) external;
    function transferOwnership(address newOwner) external;
    function acceptOwnership() external;
}
