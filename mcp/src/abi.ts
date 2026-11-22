import { parseAbi } from "viem";

export const engineAbi = parseAbi([
  "function engineKind() view returns (string)",
  "function params() view returns (uint256,uint256,uint256,uint256,uint256)",
  "function totalExposure() view returns (uint256)",
  "function exposureOf(uint8,uint8) view returns (uint256)",
  "function capBpsOf(uint8,uint8) view returns (uint256)",
  "function tableInfo(uint256) view returns (bool,bool,uint8,uint8)",
]);

export const vaultAbi = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function lockedAssets() view returns (uint256)",
  "function utilizationBps() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function minHold() view returns (uint256)",
]);

export const bookAbi = parseAbi([
  "error PausedError()",
  "error UnknownSeason()",
  "error TableMismatch()",
  "error YearOutOfRange()",
  "error TooLate(uint256 latestPurchase)",
  "error TooEarlyToBuy(uint256 earliestPurchase)",
  "error RoundAlreadyReporting()",
  "error PayoutTooSmall(uint256 min)",
  "error PremiumAboveMax(uint256 premium)",
  "error UnknownTable()",
  "error TableDisabled()",
  "error OutOfRange()",
  "error RateTooHigh()",
  "error ZeroPayout()",
  "error AmountTooLarge()",
  "error MathOverflow()",
  "error UnknownPolicy()",
  "struct Policy { address holder; uint16 year; uint8 status; uint32 trigger; uint64 tableId; uint64 purchasedAt; uint128 payout; uint128 premium; }",
  "function engineKind() view returns (string)",
  "function policyCount() view returns (uint256)",
  "function paused() view returns (bool)",
  "function quote(uint256,uint256,uint256,uint256) view returns (uint256,uint256,uint256,uint256,bool)",
  "function getPolicy(uint256) view returns (Policy)",
  "function roundExposure(uint256) view returns (uint256)",
  "function contestedAt(uint256) view returns (uint256)",
]);

export const oracleAbi = parseAbi([
  "struct Round { uint8 state; address proposer; address disputer; uint64 proposedAt; uint64 disputedAt; uint128 bond; uint32 era5Total; uint32 era5Max3; uint32 powerTotal; uint32 powerMax3; uint64 totalX2; uint64 max3X2; }",
  "function getRound(uint256) view returns (Round)",
  "function isReplay(uint256) view returns (bool)",
  "function seasonWindow(uint256,uint256) view returns (uint256,uint256)",
  "function challengeEndsAt(uint256) view returns (uint256)",
  "function resolverDeadline(uint256) view returns (uint256)",
  "function reportableFrom(uint256,uint256) view returns (uint256)",
  "function reportDeadline(uint256) view returns (uint256)",
  "function requiredBond(uint256) view returns (uint256)",
  "function maxSpreadBps() view returns (uint256)",
  "function resolver() view returns (address)",
]);
