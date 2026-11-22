import { useQuery } from "@tanstack/react-query";
import { useReadContract, useReadContracts } from "wagmi";
import { parseAbiItem } from "viem";
import { addr, chain, publicClient, START_BLOCK } from "./chain";
import { bookAbi } from "./abi";
import { seasonByLocSeasonId } from "./data";

export interface PolicyRow {
  id: number;
  holder: `0x${string}`;
  year: number;
  status: number; // 1 active, 2 paid, 3 expired, 4 refunded
  trigger: number;
  tableId: number;
  locSeasonId: number;
  peril: "drought" | "flood";
  purchasedAt: number;
  payout: bigint;
  premium: bigint;
  roundId: bigint;
  replay: boolean;
  buyTx?: string;
  settleTx?: string;
  settleBlock?: bigint;
  triggered?: boolean;
  settlementX2?: bigint;
  contested?: { era5X: bigint; powerX: bigint; spreadBps: bigint; oppositeSides: boolean };
}

export const STATUS = ["", "Active", "Paid out", "No payout (expired)", "Refunded", "Contested: with resolver"] as const;

const bought = parseAbiItem("event PolicyBought(uint256 indexed policyId, address indexed holder, uint256 indexed roundId, uint256 tableId, uint256 year, uint256 trigger, uint256 payout, uint256 premium, bool replay)");
const settled = parseAbiItem("event PolicySettled(uint256 indexed policyId, address indexed holder, bool triggered, uint256 payout, uint256 settlementX2, bool replay)");
const contested = parseAbiItem("event PolicyContested(uint256 indexed policyId, address indexed holder, uint256 era5X, uint256 powerX, uint256 spreadBps, bool oppositeSides, bool replay)");
const refunded = parseAbiItem("event PolicyRefunded(uint256 indexed policyId, address indexed holder, uint256 premium, bool replay)");

export function usePolicies() {
  const count = useReadContract({ address: addr.book, abi: bookAbi, functionName: "policyCount", chainId: chain.id, query: { refetchInterval: 15_000 } });
  const n = Number(count.data ?? 0n);
  const ids = Array.from({ length: n }, (_, i) => i + 1);
  const reads = useReadContracts({
    contracts: ids.map((id) => ({ address: addr.book, abi: bookAbi, functionName: "getPolicy", args: [BigInt(id)], chainId: chain.id }) as const),
    query: { enabled: n > 0, refetchInterval: 15_000 },
  });
  const logs = useQuery({
    queryKey: ["policy-logs", n],
    enabled: true,
    refetchInterval: 20_000,
    queryFn: async () => {
      const common = { address: addr.book, fromBlock: START_BLOCK, toBlock: "latest" as const };
      const [b, s, r, c] = await Promise.all([publicClient.getLogs({ ...common, event: bought }), publicClient.getLogs({ ...common, event: settled }), publicClient.getLogs({ ...common, event: refunded }), publicClient.getLogs({ ...common, event: contested })]);
      return { b, s, r, c };
    },
  });

  const rows: PolicyRow[] = [];
  reads.data?.forEach((res, i) => {
    const p = res.result as any;
    if (!p) return;
    const id = ids[i];
    const tableId = Number(p.tableId);
    const locSeasonId = Math.floor(tableId / 2);
    const bl = logs.data?.b.find((l) => Number(l.args.policyId) === id);
    const sl = logs.data?.s.find((l) => Number(l.args.policyId) === id);
    const rl = logs.data?.r.find((l) => Number(l.args.policyId) === id);
    const cl = logs.data?.c.find((l) => Number(l.args.policyId) === id);
    rows.push({
      id,
      holder: p.holder,
      year: Number(p.year),
      status: Number(p.status),
      trigger: Number(p.trigger),
      tableId,
      locSeasonId,
      peril: tableId % 2 === 0 ? "drought" : "flood",
      purchasedAt: Number(p.purchasedAt),
      payout: p.payout,
      premium: p.premium,
      roundId: (BigInt(locSeasonId) << 16n) | BigInt(p.year),
      replay: bl?.args.replay === true,
      buyTx: bl?.transactionHash,
      settleTx: (sl ?? rl)?.transactionHash,
      settleBlock: (sl ?? rl)?.blockNumber ?? undefined,
      triggered: sl?.args.triggered,
      settlementX2: sl?.args.settlementX2,
      contested: cl ? { era5X: cl.args.era5X!, powerX: cl.args.powerX!, spreadBps: cl.args.spreadBps!, oppositeSides: cl.args.oppositeSides! } : undefined,
    });
  });
  const place = (r: PolicyRow) => {
    const s = seasonByLocSeasonId(r.locSeasonId);
    return s ? `${s.location.name} · ${s.name}` : `season ${r.locSeasonId}`;
  };
  return { rows, place, isLoading: count.isLoading || reads.isLoading, error: count.error ?? reads.error, logsError: logs.error, refetch: () => { count.refetch(); reads.refetch(); logs.refetch(); } };
}
