import { useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts, useSwitchChain, useWriteContract } from "wagmi";
import { addr, chain, explorerTx } from "../lib/chain";
import { bookAbi, oracleAbi, tokenAbi } from "../lib/abi";
import { usePolicies } from "../lib/policies";
import { seasonByLocSeasonId, perilOf } from "../lib/data";
import { seasonWindow, fmtDateTime, fmtDate } from "../lib/season";
import { countdown, fmtUsd, short } from "../lib/format";
import { fetchEra5, fetchPower, type Reading } from "../lib/weather";
import { Loading, Empty, ErrorBox, ReplayTag } from "../components/States";
import { useAction, useNow } from "../lib/hooks";
import { waitOk } from "../lib/tx";
import { Link } from "react-router-dom";
import { assess, calibrateFor } from "../lib/contest";

const STATES = ["Nothing reported", "Report posted · dispute window open", "Disputed · waiting for the resolver", "Final", "Voided"] as const;
const C = { chainId: chain.id } as const;

export default function Monitor() {
  const now = useNow(1000);
  const { rows, isLoading, error, refetch } = usePolicies();
  const rounds = useMemo(() => {
    const m = new Map<string, { roundId: bigint; locSeasonId: number; year: number; replay: boolean; n: number }>();
    rows.forEach((r) => {
      const k = r.roundId.toString();
      const e = m.get(k);
      if (e) e.n++;
      else m.set(k, { roundId: r.roundId, locSeasonId: r.locSeasonId, year: r.year, replay: r.replay, n: 1 });
    });
    return [...m.values()];
  }, [rows]);
  const [sel, setSel] = useState<string | null>(null);
  const cur = rounds.find((r) => r.roundId.toString() === sel) ?? rounds[0];

  if (isLoading) return <div className="wrap" style={{ padding: "40px 20px" }}><Loading /></div>;
  if (error) return <div className="wrap" style={{ padding: "40px 20px" }}><ErrorBox title="Could not read policies" detail={error.message} retry={refetch} /></div>;

  return (
    <div className="wrap">
      <div className="page-head reveal">
        <div className="eyebrow">Trigger monitor</div>
        <h1>Where each season stands</h1>
        <p className="lede">Live readings from both weather sources, the oracle's status, and the countdown to finalisation. Anyone can report, dispute or finalise: that is the point of a verifiable oracle.</p>
      </div>
      {!cur ? (
        <Empty title="No covered seasons yet"><p><Link to="/">Buy a cover</Link> and its season appears here.</p></Empty>
      ) : (
        <>
          <label className="field" style={{ maxWidth: 520 }}>
            <span>Covered season</span>
            <select value={cur.roundId.toString()} onChange={(e) => setSel(e.target.value)}>
              {rounds.map((r) => {
                const s = seasonByLocSeasonId(r.locSeasonId);
                return <option key={r.roundId.toString()} value={r.roundId.toString()}>{s?.location.name} · {s?.name} {r.year}{r.replay ? " — Replay" : ""} ({r.n} {r.n === 1 ? "policy" : "policies"})</option>;
              })}
            </select>
          </label>
          <RoundPanel key={cur.roundId.toString()} round={cur} policies={rows.filter((r) => r.roundId === cur.roundId)} now={now} refetchPolicies={refetch} />
        </>
      )}
    </div>
  );
}

function RoundPanel({ round, policies, now, refetchPolicies }: { round: { roundId: bigint; locSeasonId: number; year: number; replay: boolean }; policies: ReturnType<typeof usePolicies>["rows"]; now: number; refetchPolicies: () => void }) {
  const season = seasonByLocSeasonId(round.locSeasonId)!;
  const [start, end] = seasonWindow(season, round.year);
  const { address, chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();

  const o = useReadContracts({
    contracts: [
      { address: addr.oracle, abi: oracleAbi, functionName: "getRound", args: [round.roundId], ...C },
      { address: addr.oracle, abi: oracleAbi, functionName: "challengeEndsAt", args: [round.roundId], ...C },
      { address: addr.oracle, abi: oracleAbi, functionName: "resolverDeadline", args: [round.roundId], ...C },
      { address: addr.oracle, abi: oracleAbi, functionName: "reportableFrom", args: [BigInt(round.locSeasonId), BigInt(round.year)], ...C },
      { address: addr.oracle, abi: oracleAbi, functionName: "reportDeadline", args: [round.roundId], ...C },
      { address: addr.oracle, abi: oracleAbi, functionName: "requiredBond", args: [round.roundId], ...C },
      { address: addr.oracle, abi: oracleAbi, functionName: "resolver", ...C },
      { address: addr.oracle, abi: oracleAbi, functionName: "maxSpreadBps", ...C },
      { address: addr.book, abi: bookAbi, functionName: "contestTimeout", ...C },
    ],
    query: { refetchInterval: 8000 },
  });
  const bal = useReadContract({ address: addr.token, abi: tokenAbi, functionName: "balanceOf", args: address ? [address] : undefined, ...C, query: { enabled: !!address } });
  const allowance = useReadContract({ address: addr.token, abi: tokenAbi, functionName: "allowance", args: address ? [address, addr.oracle] : undefined, ...C, query: { enabled: !!address } });

  // ---- live readings from both sources
  const [live, setLive] = useState<{ era5: Reading | null; power: Reading | null; err?: string } | "loading" | "future">("loading");
  useEffect(() => {
    let alive = true;
    const today = Math.floor(Date.now() / 1000);
    if (start > today) { setLive("future"); return; }
    const last = Math.min(end - 86400, today - 86400);
    setLive("loading");
    Promise.allSettled([fetchEra5(season.location.lat, season.location.lon, start, last), fetchPower(season.location.lat, season.location.lon, start, last)]).then(([a, b]) => {
      if (!alive) return;
      setLive({
        era5: a.status === "fulfilled" ? a.value : null,
        power: b.status === "fulfilled" ? b.value : null,
        err: [a, b].filter((x) => x.status === "rejected").map((x: any) => x.reason?.message).join("; ") || undefined,
      });
    });
    return () => { alive = false; };
  }, [season, start, end]);

  const ensureChain = async () => { if (chainId !== chain.id) await switchChainAsync({ chainId: chain.id }); };
  const approveIfNeeded = async (amount: bigint) => {
    if ((bal.data ?? 0n) < amount) await waitOk(await writeContractAsync({ address: addr.token, abi: tokenAbi, functionName: "faucet", ...C }));
    if ((allowance.data ?? 0n) < amount) await waitOk(await writeContractAsync({ address: addr.token, abi: tokenAbi, functionName: "approve", args: [addr.oracle, amount], ...C }));
  };
  const [lastTx, setLastTx] = useState<string | null>(null);
  const done = async (h: `0x${string}`) => { await waitOk(h); setLastTx(h); o.refetch(); refetchPolicies(); };

  const propose = useAction(async () => {
    if (typeof live !== "object" || !live.era5 || !live.power) throw new Error("Both sources must return data for the whole season first.");
    await ensureChain();
    const t = (x: number) => Math.round(x * 10);
    await approveIfNeeded(bond);
    await done(await writeContractAsync({ address: addr.oracle, abi: oracleAbi, functionName: "propose", args: [BigInt(round.locSeasonId), BigInt(round.year), t(live.era5.total), t(live.era5.max3), t(live.power.total), t(live.power.max3), bond], ...C }));
  });
  const dispute = useAction(async () => {
    await ensureChain();
    await approveIfNeeded(rd.bond as bigint);
    await done(await writeContractAsync({ address: addr.oracle, abi: oracleAbi, functionName: "dispute", args: [round.roundId], ...C }));
  });
  const simple = (fn: "finalize" | "voidDisputed" | "voidUnreported") => useAction(async () => { await ensureChain(); await done(await writeContractAsync({ address: addr.oracle, abi: oracleAbi, functionName: fn, args: [round.roundId], ...C })); });
  const finalize = simple("finalize");
  const voidDisp = simple("voidDisputed");
  const voidUnrep = simple("voidUnreported");
  const rule = useAction(async (id: number, pay: boolean) => { await ensureChain(); await done(await writeContractAsync({ address: addr.book, abi: bookAbi, functionName: "resolveContested", args: [BigInt(id), pay], ...C })); });
  const refundContested = useAction(async (id: number) => { await ensureChain(); await done(await writeContractAsync({ address: addr.book, abi: bookAbi, functionName: "refundContested", args: [BigInt(id)], ...C })); });
  const settle = useAction(async (id: number, refund: boolean) => { await ensureChain(); await done(await writeContractAsync({ address: addr.book, abi: bookAbi, functionName: refund ? "refund" : "settle", args: [BigInt(id)], ...C })); });

  if (o.isLoading) return <Loading />;
  if (o.isError || !o.data) return <ErrorBox title="Could not read the oracle" detail={o.error?.message} retry={() => o.refetch()} />;
  const rd = o.data[0].result as any;
  const state = Number(rd?.state ?? 0);
  const challengeEnds = Number(o.data[1].result ?? 0n);
  const resolverEnds = Number(o.data[2].result ?? 0n);
  const reportFrom = Number(o.data[3].result ?? 0n);
  const reportBy = Number(o.data[4].result ?? 0n);
  const bond = (o.data[5].result as bigint) ?? 0n;
  const resolver = o.data[6].result as string;
  const maxSpread = Number((o.data[7].result as bigint) ?? 5000n);
  const contestTimeout = Number((o.data[8].result as bigint) ?? 0n);

  const dTot = perilOf(season, "drought");
  const dFl = perilOf(season, "flood");
  const calibrate = (e: number, p: number, kind: "total" | "max3") => {
    const c = kind === "total" ? dTot : dFl;
    return (e * c.calibration_era5_ppm + p * c.calibration_power_ppm) / 2e6;
  };
  const liveSettle = typeof live === "object" && live.era5 && live.power ? { total: calibrate(live.era5.total, live.power.total, "total"), max3: calibrate(live.era5.max3, live.power.max3, "max3") } : null;
  const liveSrc = typeof live === "object" && live.era5 && live.power ? { total: assess("drought", 0, calibrateFor(dTot, live.era5.total, live.power.total).eraX, calibrateFor(dTot, live.era5.total, live.power.total).powX, maxSpread), max3: assess("flood", 0, calibrateFor(dFl, live.era5.max3, live.power.max3).eraX, calibrateFor(dFl, live.era5.max3, live.power.max3).powX, maxSpread) } : null;
  const spreadTxt = (bps: number) => `${(bps / 100).toFixed(0)}% ${bps > maxSpread ? "(over the limit)" : ""}`;
  const seasonOver = now >= end;

  const stage = state === 3 ? 4 : state === 4 ? 4 : state === 2 ? 2 : state === 1 ? 2 : seasonOver ? 1 : 0;

  return (
    <div className="grid" style={{ gap: 22 }}>
      <div className="card reveal">
        <h3>
          <span>{season.location.name} · {season.name} {round.year} {round.replay && <ReplayTag />}</span>
          <span className="tag dim">{STATES[state]}</span>
        </h3>
        <div className="small muted">Season {fmtDate(start)} – {fmtDate(end - 86400)} · {season.location.name} {season.location.lat.toFixed(2)}°, {season.location.lon.toFixed(2)}°</div>
        <div className={`flow${state === 3 && policies.some((p) => p.status === 2) ? " paid" : ""}`} style={{ marginTop: 18 }}>
          {["Season", "Report", "Dispute window", "Final", "Settled"].map((n, i) => (
            <span key={n} style={{ display: "contents" }}>
              <span className="node" style={{ background: i <= stage ? "var(--ink)" : "var(--card)", color: i <= stage ? "var(--paper)" : "var(--ink)" }}>{n}</span>
              {i < 4 && <span className="arrow" style={{ opacity: i < stage ? 1 : 0.35 }} />}
            </span>
          ))}
        </div>
        <div className="grid g3" style={{ marginTop: 14 }}>
          <Clock label="Report window" v={state === 0 ? (now < reportFrom ? `opens in ${countdown(reportFrom - now)}` : now <= reportBy ? `closes in ${countdown(reportBy - now)}` : "closed") : "report posted"} sub={`opens ${fmtDateTime(reportFrom)}`} />
          <Clock label="Dispute window" v={state === 1 ? (challengeEnds > now ? `ends in ${countdown(challengeEnds - now)}` : "ended: ready to finalise") : state === 2 ? `resolver deadline in ${countdown(Math.max(0, resolverEnds - now))}` : state >= 3 ? "closed" : "not started"} sub={state === 1 ? fmtDateTime(challengeEnds) : undefined} big={state === 1} />
          <Clock label="Oracle bond" v={`${fmtUsd(state === 0 ? bond : (rd.bond as bigint))} tUSD`} sub={`resolver ${short(resolver)}`} />
        </div>
      </div>

      <div className="grid g2">
        <div className="card reveal d1">
          <h3>Readings from the two sources</h3>
          {live === "loading" ? <Loading label="Asking Open-Meteo and NASA POWER…" /> : live === "future" ? <div className="note">This season has not started, so there is no rain to read yet. Readings appear from {fmtDate(start)}.</div> : (
            <>
              <table className="data">
                <thead><tr><th>Source</th><th className="num">Season total</th><th className="num">Max 3-day</th><th>Through</th></tr></thead>
                <tbody>
                  <tr><td>ERA5 · Open-Meteo</td><td className="num">{live.era5 ? `${live.era5.total.toFixed(1)} mm` : "—"}</td><td className="num">{live.era5 ? `${live.era5.max3.toFixed(1)} mm` : "—"}</td><td>{live.era5?.lastDate ?? "unavailable"}</td></tr>
                  <tr><td>NASA POWER</td><td className="num">{live.power ? `${live.power.total.toFixed(1)} mm` : "—"}</td><td className="num">{live.power ? `${live.power.max3.toFixed(1)} mm` : "—"}</td><td>{live.power?.lastDate ?? "unavailable"}</td></tr>
                  {liveSrc && <tr><td>Spread between sources</td><td className="num">{spreadTxt(liveSrc.total.spreadBps)}</td><td className="num">{spreadTxt(liveSrc.max3.spreadBps)}</td><td>limit {maxSpread / 100}% of the mean</td></tr>}
                  {liveSettle && <tr style={{ fontWeight: 600 }}><td>Calibrated median</td><td className="num">{liveSettle.total.toFixed(1)} mm</td><td className="num">{liveSettle.max3.toFixed(1)} mm</td><td>what the contract computes</td></tr>}
                </tbody>
              </table>
              {live.err && <div className="note small">One source did not answer ({live.err}). The other is shown; a report needs both.</div>}
              {!seasonOver && <div className="note small">Season still running: these are season-to-date figures. A report can only be posted after the season ends.</div>}
            </>
          )}
          {state >= 1 && (
            <>
              <div className="hr" />
              <div className="eyebrow">Posted on-chain {round.replay && <ReplayTag />}</div>
              <div className="mono small">
                ERA5 {(Number(rd.era5Total) / 10).toFixed(1)} mm total, {(Number(rd.era5Max3) / 10).toFixed(1)} mm max 3-day<br />
                POWER {(Number(rd.powerTotal) / 10).toFixed(1)} mm total, {(Number(rd.powerMax3) / 10).toFixed(1)} mm max 3-day<br />
                by {short(rd.proposer)}{state === 3 && <> · final {(Number(rd.totalX2) / 20).toFixed(1)} mm / {(Number(rd.max3X2) / 20).toFixed(1)} mm</>}
              </div>
            </>
          )}
        </div>

        <div className="card reveal d2">
          <h3>Policies in this season</h3>
          <table className="data stack">
            <thead><tr><th>#</th><th>Trigger</th><th className="num">Payout</th><th>Now</th><th /></tr></thead>
            <tbody>
              {policies.map((p) => {
                const pd = p.peril === "drought" ? dTot : dFl;
                // the readings the contract will use: the posted report if there is one, else the live ones
                const src = state >= 1
                  ? calibrateFor(pd, Number(p.peril === "drought" ? rd.era5Total : rd.era5Max3) / 10, Number(p.peril === "drought" ? rd.powerTotal : rd.powerMax3) / 10)
                  : typeof live === "object" && live.era5 && live.power
                    ? calibrateFor(pd, p.peril === "drought" ? live.era5.total : live.era5.max3, p.peril === "drought" ? live.power.total : live.power.max3)
                    : null;
                const as = src ? assess(p.peril, p.trigger, src.eraX, src.powX, maxSpread) : null;
                const val = liveSettle ? (p.peril === "drought" ? liveSettle.total : liveSettle.max3) : null;
                const wouldPay = val === null ? null : p.peril === "drought" ? val <= p.trigger : val >= p.trigger;
                return (
                  <tr key={p.id}>
                    <td data-label="#">{p.id}</td>
                    <td data-label="Trigger"><span className={`tag ${p.peril}`}>{p.peril}</span> {p.peril === "drought" ? "≤" : "≥"} {p.trigger} mm</td>
                    <td className="num" data-label="Payout">{fmtUsd(p.payout, 0)}</td>
                    <td data-label="Now">
                      {p.status === 2 ? <span className="tag ok">paid</span> : p.status === 3 ? <span className="tag dim">no payout</span> : p.status === 4 ? <span className="tag dim">refunded</span> : p.status === 5 ? <span className="tag warn">contested: resolver decides</span> : as?.contested ? <span className="tag warn" title="Sources on opposite sides of the trigger or too far apart: will go to the resolver">will be contested</span> : wouldPay === null ? "—" : <span className={`tag ${wouldPay ? "ok" : "dim"}`}>{wouldPay ? "on course to pay" : "not triggered"}</span>}
                      {as && (
                        <div className="muted" style={{ marginTop: 4 }}>
                          ERA5 {(as.eraX / 10).toFixed(1)} mm {as.eraSays ? "pays" : "no pay"} · POWER {(as.powX / 10).toFixed(1)} mm {as.powSays ? "pays" : "no pay"}
                          <br />spread {(as.spreadBps / 100).toFixed(0)}%{as.opposite ? " · opposite sides" : as.spreadBps > maxSpread ? " · over the limit" : " · agree"}
                        </div>
                      )}
                    </td>
                    <td data-label="Action">
                      {p.status === 1 && (state === 3 || state === 4) && <button className="btn small" disabled={settle.status === "pending"} onClick={() => settle.run(p.id, state === 4)}>{state === 4 ? "Refund" : "Settle"}</button>}
                      {p.status === 5 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {address?.toLowerCase() === resolver.toLowerCase() ? (
                            <>
                              <button className="btn small" disabled={rule.status === "pending"} onClick={() => rule.run(p.id, true)}>Rule: pay</button>
                              <button className="btn ghost small" disabled={rule.status === "pending"} onClick={() => rule.run(p.id, false)}>Rule: no pay</button>
                            </>
                          ) : <span className="muted">resolver {short(resolver)}</span>}
                          <button className="btn ghost small" disabled={refundContested.status === "pending"} onClick={() => refundContested.run(p.id)} title={`Possible once the resolver has been silent for ${countdown(contestTimeout)}`}>Refund (resolver silent)</button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {settle.status === "error" && <div className="note bad small">{settle.error}</div>}
          {rule.status === "error" && <div className="note bad small">{rule.error}</div>}
          {refundContested.status === "error" && <div className="note bad small">{refundContested.error}</div>}
          <p className="small muted">Rule: if ERA5 and NASA POWER land on opposite sides of a policy's trigger, or are more than {maxSpread / 100}% of their mean apart, the policy is <b>contested</b> and the named resolver decides instead of paying automatically. If the resolver stays silent for {countdown(contestTimeout)}, anyone can refund the premium.</p>
        </div>
      </div>

      <div className="card reveal">
        <h3>Oracle actions <span className="small muted">anyone can do these</span></h3>
        {!isConnected ? <p className="muted">Connect a wallet to report, dispute or finalise.</p> : (
          <div className="grid g3">
            {state === 0 && (
              <ActionBox title="Report this season" text={`Post both sources' readings and lock a ${fmtUsd(bond)} tUSD bond (returned after the dispute window, plus a small reward).`}>
                <button className="btn block" disabled={!seasonOver || now < reportFrom || propose.status === "pending" || !(typeof live === "object" && live.era5 && live.power)} onClick={() => propose.run()}>{propose.status === "pending" ? <span className="spinner" /> : "Report with live readings"}</button>
                {now < reportFrom && <div className="small muted">Opens {fmtDateTime(reportFrom)} (data lag).</div>}
                <Err a={propose} />
              </ActionBox>
            )}
            {state === 1 && (
              <>
                <ActionBox title="Dispute" text={`Think the report is wrong? Lock an equal bond (${fmtUsd(rd.bond)} tUSD). A named resolver rules; the loser forfeits their bond.`}>
                  <button className="btn ghost block" disabled={dispute.status === "pending" || challengeEnds <= now} onClick={() => dispute.run()}>{dispute.status === "pending" ? <span className="spinner" /> : "Dispute report"}</button>
                  <Err a={dispute} />
                </ActionBox>
                <ActionBox title="Finalise" text="After the window closes with no dispute, anyone can finalise; the reporter gets the bond back plus a reward.">
                  <button className="btn block" disabled={finalize.status === "pending" || challengeEnds > now} onClick={() => finalize.run()}>{finalize.status === "pending" ? <span className="spinner" /> : challengeEnds > now ? `Ready in ${countdown(challengeEnds - now)}` : "Finalise now"}</button>
                  <Err a={finalize} />
                </ActionBox>
              </>
            )}
            {state === 2 && (
              <ActionBox title="Resolver silent?" text="If the resolver does not rule before its deadline, anyone can void the round. Premiums are refunded; both sides lose 10% of their bond.">
                <button className="btn block" disabled={voidDisp.status === "pending" || resolverEnds >= now} onClick={() => voidDisp.run()}>{resolverEnds >= now ? `Available in ${countdown(resolverEnds - now)}` : "Void the round"}</button>
                <Err a={voidDisp} />
              </ActionBox>
            )}
            {state === 0 && now > reportBy && (
              <ActionBox title="Nobody reported" text="The reporting window passed. Void the round so policyholders can claim a full premium refund.">
                <button className="btn block" disabled={voidUnrep.status === "pending"} onClick={() => voidUnrep.run()}>Void the round</button>
                <Err a={voidUnrep} />
              </ActionBox>
            )}
            {(state === 3 || state === 4) && <p className="muted">This round is {state === 3 ? "final" : "voided"}. Settle or refund the policies above.</p>}
          </div>
        )}
        {lastTx && <div className="note ok small">Confirmed. <a href={explorerTx(lastTx)} target="_blank" rel="noreferrer">View transaction</a></div>}
      </div>
    </div>
  );
}

const Clock = ({ label, v, sub, big }: { label: string; v: string; sub?: string; big?: boolean }) => (
  <div className="stat"><div className="k">{label}</div><div className="v" style={{ fontSize: big ? "2rem" : "1.25rem" }}>{v}</div>{sub && <div className="s">{sub}</div>}</div>
);
const ActionBox = ({ title, text, children }: { title: string; text: string; children: React.ReactNode }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}><h3 style={{ marginBottom: 0 }}>{title}</h3><p className="small muted" style={{ margin: 0 }}>{text}</p>{children}</div>
);
const Err = ({ a }: { a: { status: string; error?: string } }) => (a.status === "error" ? <div className="note bad small">{a.error}</div> : null);
