import { publicClient } from "./chain";

/** waits for a mined receipt and throws if the transaction reverted */
export async function waitOk(hash: `0x${string}`) {
  const r = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (r.status !== "success") throw new Error("Transaction reverted on-chain");
  return r;
}
