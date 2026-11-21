// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSD
/// @notice TESTNET-ONLY play money used to pay premiums and fund the underwriter vault.
///         It has no value. Anyone can mint a fixed amount from the public faucet.
contract TestUSD is ERC20 {
    /// @notice amount minted per faucet claim (6 decimals)
    uint256 public constant FAUCET_AMOUNT = 10_000e6;
    /// @notice minimum time between claims for one address
    uint256 public constant FAUCET_COOLDOWN = 1 hours;

    mapping(address => uint256) public lastClaim;

    error FaucetCooldown(uint256 availableAt);

    event FaucetClaimed(address indexed to, uint256 amount);

    constructor() ERC20("Dryspell Test USD (testnet, no value)", "tUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Mint FAUCET_AMOUNT to the caller. Rate-limited per address.
    function faucet() external {
        uint256 last = lastClaim[msg.sender];
        if (last != 0 && block.timestamp < last + FAUCET_COOLDOWN) revert FaucetCooldown(last + FAUCET_COOLDOWN);
        lastClaim[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
        emit FaucetClaimed(msg.sender, FAUCET_AMOUNT);
    }
}
