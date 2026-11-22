import { useState } from "react";
import { useAccount, useReadContracts, useWriteContract, useSwitchChain } from "wagmi";
import { addr, chain, explorerAddress, explorerTx } from "../lib/chain";
import { engineAbi, tokenAbi, vaultAbi } from "../lib/abi";
import { regions } from "../lib/data";
import { fmtUsd, parseUsd } from "../lib/format";
import { fmtDateTime } from "../lib/season";
import { Loading, Stat, ErrorBox } from "../components/States";
import { useAction, useNow } from "../lib/hooks";
import { waitOk } from "../lib/tx";

const C = { chainId: chain.id } as const;
const perils = ["drought", "flood"] as const;

export default function Vault() {
  const now = useNow(1000);
  const { address, chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const base = useReadContracts({
    contracts: [
      { address: addr.vault, abi: vaultAbi, functionName: "totalAssets", ...C },
      { address: addr.vault, abi: vaultAbi, functionName: "lockedAssets", ...C },
      { address: addr.vault, abi: vaultAbi, functionName: "utilizationBps", ...C },
      { address: addr.vault, abi: vaultAbi, functionName: "convertToAssets", args: [1_000_000_000n], ...C },
      { address: addr.engine, abi: engineAbi, functionName: "totalExposure", ...C },
      { address: addr.engine, abi: engineAbi, functionName: "params", ...C },
      { address: addr.vault, abi: vaultAbi, functionName: "minHold", ...C },
    ],
    query: { refetchInterval: 10_000 },
  });
  const matrix = useReadContracts({
    contracts: regions.flatMap((_, r) =>
      perils.flatMap((_, p) => [
        { address: addr.engine, abi: engineAbi, functionName: "exposureOf", args: [r, p], ...C } as const,
        { address: addr.engine, abi: engineAbi, functionName: "capBpsOf", args: [r, p], ...C } as const,
      ]),
    ),
    query: { refetchInterval: 10_000 },
  });
  const mine = useReadContracts({
    contracts: address
      ? [
          { address: addr.vault, abi: vaultAbi, functionName: "balanceOf", args: [address], ...C },
          { address: addr.vault, abi: vaultAbi, functionName: "maxWithdraw", args: [address], ...C },
          { address: addr.vault, abi: vaultAbi, functionName: "maxRedeem", args: [address], ...C },
          { address: addr.vault, abi: vaultAbi, functionName: "withdrawableAt", args: [address], ...C },
          { address: addr.token, abi: tokenAbi, functionName: "balanceOf", args: [address], ...C },
          { address: addr.token, abi: tokenAbi, functionName: "allowance", args: [address, addr.vault], ...C },
        ]
      : [],
    query: { enabled: !!address, refetchInterval: 8000 },
  });

  const [dep, setDep] = useState("1000");
  const [wd, setWd] = useState("");
  const refetchAll = () => {
    base.refetch();
    matrix.refetch();
    mine.refetch();
  };

  const [tx, setTx] = useState<string | null>(null);
  const [step, setStep] = useState("");
  const ensureChain = async () => {
    if (chainId !== chain.id) await switchChainAsync({ chainId: chain.id });
  };
  const deposit = useAction(async () => {
    if (!address) return;
    const amt = parseUsd(dep);
    if (amt === 0n) throw new Error("Enter an amount above zero.");
    await ensureChain();
    const [, , , , bal, allow] = (mine.data ?? []).map((r) => r.result as bigint | undefined);
    if ((bal ?? 0n) < amt) {
      setStep("Claiming test tUSD from the faucet…");
      await waitOk(await writeContractAsync({ address: addr.token, abi: tokenAbi, functionName: "faucet", ...C }));
    }
    if ((allow ?? 0n) < amt) {
      setStep("Approving tUSD…");
      await waitOk(await writeContractAsync({ address: addr.token, abi: tokenAbi, functionName: "approve", args: [addr.vault, amt], ...C }));
    }
    setStep("Depositing…");
    const h = await writeContractAsync({ address: addr.vault, abi: vaultAbi, functionName: "deposit", args: [amt, address], ...C });
    await waitOk(h);
    setTx(h);
    refetchAll();
  });
  const withdraw = useAction(async () => {
    if (!address) return;
    await ensureChain();
    const amt = parseUsd(wd);
    const max = (mine.data?.[1]?.result as bigint | undefined) ?? 0n;
    if (amt === 0n) throw new Error("Enter an amount above zero.");
    if (amt > max) throw new Error(`You can withdraw at most ${fmtUsd(max)} tUSD right now.`);
    setStep("Withdrawing…");
    const h = await writeContractAsync({ address: addr.vault, abi: vaultAbi, functionName: "withdraw", args: [amt, address, address], ...C });
    await waitOk(h);
    setTx(h);
    refetchAll();
  });

  if (base.isLoading) return <div className="wrap" style={{ padding: "40px 20px" }}><Loading /></div>;
  if (base.isError || !base.data) return <div className="wrap" style={{ padding: "40px 20px" }}><ErrorBox title="Could not read the vault" detail={base.error?.message} retry={() => base.refetch()} /></div>;

  const [assets, locked, util, price, exposure, engineParams, minHold] = base.data.map((r) => r.result) as [bigint, bigint, bigint, bigint, bigint, readonly bigint[], bigint];
  const sharePrice = Number(price) / 1e6; // assets per share, in tUSD
  const maxUtil = Number(engineParams[4]);
  const myShares = mine.data?.[0]?.result as bigint | undefined;
  const myMax = mine.data?.[1]?.result as bigint | undefined;
  const myWhen = mine.data?.[3]?.result as bigint | undefined;
  const myBal = mine.data?.[4]?.result as bigint | undefined;
  const myValue = myShares !== undefined ? (myShares * price) / 1_000_000_000n : undefined;
  const holdLeft = myWhen && Number(myWhen) > now ? Number(myWhen) - now : 0;

  return (
    <div className="wrap">
      <div className="page-head reveal">
        <div className="eyebrow">Underwriter vault</div>
        <h1>The pool that pays the claims</h1>
        <p className="lede">Underwriters deposit tUSD and back every policy. Premiums raise the share price; payouts lower it. Cover is fully collateralised: assets behind active policies cannot be withdrawn.</p>
      </div>

      <div className="grid g4 reveal d1">
        <Stat k="Total assets" v={`${fmtUsd(assets, 0)}`} s="tUSD in the pool" />
        <Stat k="Share value" v={sharePrice.toFixed(4)} s={`${sharePrice >= 1 ? "+" : ""}${((sharePrice - 1) * 100).toFixed(2)}% since launch (yield from premiums, net of payouts)`} />
        <Stat k="Utilisation" v={`${(Number(util) / 100).toFixed(1)}%`} s={`of assets reserved · hard cap ${maxUtil / 100}%`} />
        <Stat k="Locked / free" v={`${fmtUsd(locked, 0)}`} s={`locked · ${fmtUsd(assets - locked, 0)} free to withdraw`} />
      </div>
      <div className="bar" style={{ margin: "16px 0 4px" }} aria-label="Utilisation"><i style={{ width: `${Math.min(100, Number(util) / 100)}%` }} /></div>
      <div className="small muted mono">Exposure {fmtUsd(exposure, 0)} tUSD of {fmtUsd(assets, 0)} · deposits unlock {Number(minHold) / 3600}h after you deposit (testnet setting)</div>

      <div className="builder" style={{ marginTop: 26 }}>
        <div className="card">
          <h3>Exposure by region and peril</h3>
          <p className="small muted">Each cell is capped as a share of the pool, so one regional disaster cannot drain it.</p>
          {matrix.isLoading ? (
            <Loading />
          ) : (
            <div className="scroll-x">
              <table className="data">
                <thead>
                  <tr><th>Region</th><th>Peril</th><th className="num">Exposure</th><th className="num">Cap</th><th style={{ width: "30%" }}>Used</th></tr>
                </thead>
                <tbody>
                  {regions.flatMap((reg, r) =>
                    perils.map((p, pi) => {
                      const i = (r * 2 + pi) * 2;
                      const e = (matrix.data?.[i]?.result as bigint) ?? 0n;
                      const capBps = (matrix.data?.[i + 1]?.result as bigint) ?? 0n;
                      const capAbs = (assets * capBps) / 10000n;
                      const used = capAbs > 0n ? Number((e * 10000n) / capAbs) / 100 : 0;
                      return (
                        <tr key={`${r}${p}`}>
                          <td>{reg}</td>
                          <td><span className={`tag ${p}`}>{p}</span></td>
                          <td className="num">{fmtUsd(e, 0)}</td>
                          <td className="num">{Number(capBps) / 100}% · {fmtUsd(capAbs, 0)}</td>
                          <td><div className={`bar${used > 80 ? " warn" : ""}`}><i style={{ width: `${Math.min(100, used)}%` }} /></div></td>
                        </tr>
                      );
                    }),
                  )}
                </tbody>
              </table>
            </div>
          )}
          <div className="note" style={{ marginTop: 16 }}>
            <b>Risk to underwriters:</b> if a drought or flood triggers many policies, the share price falls by the payouts. Premiums are priced from 35 years of data with an uncertainty margin, but weather can beat any history. Testnet money only.
          </div>
        </div>

        <div className="card" style={{ position: "sticky", top: 90 }}>
          <h3>Your position</h3>
          {!isConnected ? (
            <p className="muted">Connect a wallet to deposit. A deposit needs a little Arbitrum Sepolia ETH for gas; the faucet button hands out free tUSD.</p>
          ) : (
            <>
              <div className="grid g2">
                <Stat k="Value" v={myValue === undefined ? "…" : fmtUsd(myValue)} s="tUSD" />
                <Stat k="Wallet" v={myBal === undefined ? "…" : fmtUsd(myBal, 0)} s="tUSD" />
              </div>
              <hr className="hr" />
              <label className="field">
                <span>Deposit (tUSD)</span>
                <input type="number" min="0" value={dep} onChange={(e) => setDep(e.target.value)} />
              </label>
              <button className="btn block" disabled={deposit.status === "pending"} onClick={() => deposit.run()}>
                {deposit.status === "pending" ? <><span className="spinner" /> {step}</> : "Deposit"}
              </button>
              {deposit.status === "error" && <div className="note bad small">{deposit.error}</div>}
              <hr className="hr" />
              <label className="field">
                <span>Withdraw (tUSD) · max {myMax === undefined ? "…" : fmtUsd(myMax)}</span>
                <input type="number" min="0" value={wd} onChange={(e) => setWd(e.target.value)} placeholder="0.00" />
              </label>
              <button className="btn ghost block" disabled={withdraw.status === "pending" || holdLeft > 0} onClick={() => withdraw.run()}>
                {withdraw.status === "pending" ? <><span className="spinner" /> {step}</> : holdLeft > 0 ? `Locked until ${fmtDateTime(Number(myWhen))}` : "Withdraw"}
              </button>
              {withdraw.status === "error" && <div className="note bad small">{withdraw.error}</div>}
              {tx && <div className="note ok small">Done. <a href={explorerTx(tx)} target="_blank" rel="noreferrer">View transaction</a></div>}
            </>
          )}
          <div className="small muted" style={{ marginTop: 14 }}>
            Vault contract: <a className="mono" href={explorerAddress(addr.vault)} target="_blank" rel="noreferrer">{addr.vault.slice(0, 10)}…</a>
          </div>
        </div>
      </div>
    </div>
  );
}
