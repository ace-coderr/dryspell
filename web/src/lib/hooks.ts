import { useEffect, useState, useCallback } from "react";
import { useReadContract } from "wagmi";
import { addr, chain } from "./chain";
import { bookAbi } from "./abi";

export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** reads the engine mode from the deployed contract itself */
export function useEngineKind() {
  return useReadContract({ address: addr.book, abi: bookAbi, functionName: "engineKind", chainId: chain.id, query: { staleTime: 60_000 } });
}

/** tracks a async action with idle/pending/done/error states */
export function useAction<A extends unknown[], R>(fn: (...a: A) => Promise<R>) {
  const [state, setState] = useState<{ status: "idle" | "pending" | "done" | "error"; error?: string; result?: R }>({ status: "idle" });
  const run = useCallback(
    async (...a: A) => {
      setState({ status: "pending" });
      try {
        const result = await fn(...a);
        setState({ status: "done", result });
        return result;
      } catch (e) {
        const m = (e as any)?.shortMessage ?? (e as any)?.message ?? String(e);
        setState({ status: "error", error: String(m).split("\n")[0].slice(0, 240) });
        return undefined;
      }
    },
    [fn],
  );
  return { ...state, run, reset: () => setState({ status: "idle" }) };
}
