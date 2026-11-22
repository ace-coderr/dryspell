// Turns viem errors into text a person can act on. A failed network request is not the engine saying no.
const HINTS: Record<string, string> = {
  RoundAlreadyReporting: "This season's oracle round already has a report, so no new cover can be bought on it.",
  TooLate: "Too late to buy: cover must be bought at least 14 days before the season starts (the waiting period).",
  TooEarlyToBuy: "Too early: cover can be bought at most 400 days before the season starts.",
  OutOfRange: "That trigger is outside the range the pricing table covers for this place and peril.",
  RateTooHigh: "The engine will not sell this one: the price would exceed its rate cap because the odds of paying out are too high.",
  UnknownTable: "No pricing table is loaded for this place and peril (it is not offered).",
  TableDisabled: "Selling cover on this table is switched off.",
  UnknownSeason: "This season is not defined on-chain.",
  YearOutOfRange: "The year must be 2020 or later.",
  PayoutTooSmall: "That payout is below the minimum.",
  PausedError: "New sales are paused.",
  CapBreached: "The pool cannot take that much cover right now: a region or utilisation cap would be exceeded.",
};

export type Explained = { kind: "network" | "revert"; message: string };

export function explain(e: unknown): Explained {
  let name = "";
  let net = false;
  for (let x: any = e; x; x = x.cause) {
    name = name || x?.data?.errorName || "";
    if (/HttpRequestError|HTTP request failed|Failed to fetch|NetworkError|timed out|TimeoutError/i.test(`${x?.name} ${x?.shortMessage ?? ""} ${x?.message ?? ""}`)) net = true;
  }
  if (!name && net) return { kind: "network", message: "Could not reach Arbitrum Sepolia. Check your connection and try again." };
  if (name && HINTS[name]) return { kind: "revert", message: HINTS[name] };
  const raw = String((e as any)?.shortMessage ?? (e as any)?.message ?? e).split("\n")[0];
  return { kind: net ? "network" : "revert", message: net ? "Could not reach Arbitrum Sepolia. Check your connection and try again." : raw.slice(0, 200) };
}
