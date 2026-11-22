import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useAccount, useReadContract, useReadContracts, useWriteContract, useSwitchChain } from "wagmi";
import { addr, chain, explorerTx, deployment } from "../lib/chain";
import { bookAbi, engineAbi, tokenAbi } from "../lib/abi";
import { allSeasons, locations, perilOf, tableId, roundId, type PerilName, type Season } from "../lib/data";
import { nextBuyableYear, seasonWindow, fmtDate, LEAD_TIME } from "../lib/season";
import { fmtUsd, parseUsd, pct } from "../lib/format";
import { breakdown, type EngineParams } from "../lib/pricing";
import { loadDaily, seasonSlice } from "../lib/daily";
import { RainRibbon } from "../components/RainRibbon";
import { SkyArt } from "../components/Sky";
import { Features, CtaBand } from "../components/HomeSections";
import { useTween } from "../lib/tween";
import { explain } from "../lib/errors";
import { ReplayTag, Loading } from "../components/States";
import { waitOk } from "../lib/tx";
import { useAction } from "../lib/hooks";

const offered = allSeasons.filter((s) => s.perils.some((p) => p.offered));

export default function Builder() {
  const [locId, setLocId] = useState(offered.find((s) => s.location.id === "jodhpur")?.location.id ?? offered[0].location.id);
  const loc = locations.find((l) => l.id === locId)!;
  const offeredSeasonsHere = loc.seasons.filter((s) => s.perils.some((p) => p.offered));
  const [seasonId, setSeasonId] = useState(offeredSeasonsHere[0].id);
  const season: Season = offeredSeasonsHere.find((s) => s.id === seasonId) ?? offeredSeasonsHere[0];
  const [peril, setPeril] = useState<PerilName>("drought");
  const availablePerils = season.perils.filter((p) => p.offered).map((p) => p.peril);
  const activePeril: PerilName = availablePerils.includes(peril) ? peril : availablePerils[0];
  const pd = perilOf(season, activePeril);
  const tId = tableId(season, activePeril);

  // keep selections valid when the place changes
  useEffect(() => {
    if (!offeredSeasonsHere.some((s) => s.id === seasonId)) setSeasonId(offeredSeasonsHere[0].id);
  }, [locId]); // eslint-disable-line

  // ---- season year: next forward season, or a replay round opened by the owner
  const forwardYear = nextBuyableYear(season);
  const replayYears = [2025, 2024, 2023, 2022, 2021, 2020];
  const replayFlags = useReadContracts({
    contracts: replayYears.map((y) => ({ address: addr.oracle, abi: [{ type: "function", name: "isReplay", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] }] as const, functionName: "isReplay", args: [roundId(season, y)], chainId: chain.id })),
    query: { staleTime: 30_000 },
  });
  const openReplays = replayYears.filter((_, i) => replayFlags.data?.[i]?.result === true);
  const [mode, setMode] = useState<"forward" | "replay">("forward");
  const [replayYear, setReplayYear] = useState<number | null>(null);
  const year = mode === "forward" ? forwardYear : (replayYear ?? openReplays[0] ?? null);
  useEffect(() => {
    if (mode === "replay" && !openReplays.length) setMode("forward");
  }, [openReplays.length, mode]);

  // ---- trigger and payout
  const levels = pd.table.map((r) => r.level_mm);
  const sorted = [...levels].sort((a, b) => a - b);
  const [trigIdx, setTrigIdx] = useState(Math.floor(sorted.length / 3));
  const idx = Math.min(trigIdx, sorted.length - 1);
  const trigger = sorted[idx];
  const [payoutStr, setPayoutStr] = useState("500");
  const payout = parseUsd(payoutStr);
  useEffect(() => setTrigIdx(Math.floor(sorted.length / 3)), [tId]); // eslint-disable-line

  // ---- live quote from the deployed engine (via the policy book, with timing rules applied)
  const quoteArgs = year ? ([BigInt(tId), BigInt(year), BigInt(trigger), payout] as const) : undefined;
  const quote = useReadContract({ address: addr.book, abi: bookAbi, functionName: "quote", args: quoteArgs, chainId: chain.id, query: { enabled: !!quoteArgs && payout > 0n, retry: false } });
  const params = useReadContract({ address: addr.engine, abi: engineAbi, functionName: "params", chainId: chain.id, query: { staleTime: 60_000 } });
  const minPayout = useReadContract({ address: addr.book, abi: bookAbi, functionName: "minPayout", chainId: chain.id, query: { staleTime: 600_000 } });
  const kind = useReadContract({ address: addr.book, abi: bookAbi, functionName: "engineKind", chainId: chain.id });

  const q = quote.data;
  const premium = q?.[0];
  const parts = useMemo(() => {
    if (!q || !params.data) return null;
    const [k, floor, loading, maxRate, util] = params.data;
    const ep: EngineParams = { marginKBps: k, floorPpm: floor, loadingBps: loading, maxRatePpm: maxRate, maxUtilBps: util };
    return breakdown(q[1], q[2], ep);
  }, [q, params.data]);

  // animate the premium when it changes
  const [tick, setTick] = useState(0);
  const lastPremium = useRef<bigint | undefined>(undefined);
  useEffect(() => {
    if (premium !== lastPremium.current) {
      lastPremium.current = premium;
      setTick((t) => t + 1);
    }
  }, [premium]);

  // ---- ribbon: a recent real season for context
  const [ribbon, setRibbon] = useState<{ era5: number[]; power: number[]; year: number } | null>(null);
  const [ribbonYear, setRibbonYear] = useState(2023);
  useEffect(() => {
    let live = true;
    setRibbon(null);
    loadDaily(season.location.id)
      .then((d) => {
        const s = seasonSlice(d, season, ribbonYear);
        if (live && s) setRibbon({ era5: s.era5, power: s.power, year: ribbonYear });
      })
      .catch(() => live && setRibbon(null));
    return () => {
      live = false;
    };
  }, [season, ribbonYear]);

  // ---- wallet, balances, buying
  const { address, chainId, isConnected } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const bal = useReadContract({ address: addr.token, abi: tokenAbi, functionName: "balanceOf", args: address ? [address] : undefined, chainId: chain.id, query: { enabled: !!address, refetchInterval: 8000 } });
  const allowance = useReadContract({ address: addr.token, abi: tokenAbi, functionName: "allowance", args: address ? [address, addr.book] : undefined, chainId: chain.id, query: { enabled: !!address, refetchInterval: 8000 } });
  const [steps, setSteps] = useState<string[]>([]);
  const [lastTx, setLastTx] = useState<string | null>(null);

  const buy = useAction(async () => {
    if (!premium || !year) return;
    setSteps([]);
    if (chainId !== chain.id) await switchChainAsync({ chainId: chain.id });
    const maxPremium = premium + premium / 50n; // allow 2% slippage
    if ((bal.data ?? 0n) < maxPremium) {
      setSteps((s) => [...s, "Claiming test tUSD from the faucet…"]);
      await waitOk(await writeContractAsync({ address: addr.token, abi: tokenAbi, functionName: "faucet", chainId: chain.id }));
    }
    if ((allowance.data ?? 0n) < maxPremium) {
      setSteps((s) => [...s, "Approving tUSD…"]);
      await waitOk(await writeContractAsync({ address: addr.token, abi: tokenAbi, functionName: "approve", args: [addr.book, maxPremium], chainId: chain.id }));
    }
    setSteps((s) => [...s, "Buying cover…"]);
    const hash = await writeContractAsync({ address: addr.book, abi: bookAbi, functionName: "buy", args: [BigInt(tId), BigInt(year), BigInt(trigger), payout, maxPremium], chainId: chain.id });
    await waitOk(hash);
    setLastTx(hash);
    bal.refetch();
    allowance.refetch();
    return hash;
  });

  const [start, end] = year ? seasonWindow(season, year) : [0, 0];
  const now = Math.floor(Date.now() / 1000);
  const quoteProblem = quote.isError ? explain(quote.error) : null;
  const small = minPayout.data !== undefined && payout < minPayout.data;
  const dir = activePeril === "drought" ? "at or below" : "at or above";
  const ribbonDaily = ribbon
    ? [
        { name: "ERA5 (Open-Meteo)", color: "var(--amber)", mm: ribbon.era5.map((v) => v * (pd.calibration_era5_ppm / 1e6)) },
        { name: "NASA POWER", color: "var(--teal)", mm: ribbon.power.map((v) => v * (pd.calibration_power_ppm / 1e6)) },
      ]
    : [];

  const premiumT = useTween(premium !== undefined ? Number(premium) / 1e6 : undefined);

  return (
    <>
      <section className="hero wrap nopad">
        <div className="kicker reveal">Parametric weather cover · live on Arbitrum Sepolia</div>
        <h1 className="reveal d1">When the rain data crosses the line, <em>you get paid.</em></h1>
        <p className="sub reveal d2">Pick a place, a peril and a payout. The price is worked out on-chain from 35 years of real rainfall, and the payout is released by the contract when the data crosses your trigger. No claim form. No adjuster.</p>
        <div className="hero-actions reveal d3">
          <button className="btn" onClick={() => document.getElementById("builder")?.scrollIntoView({ behavior: "smooth" })}>Build your cover</button>
          <Link className="btn ghost nochev" to="/map">See how it is priced</Link>
        </div>
      </section>
      <div className="band" />
      <section className="sky-panel" id="builder">
        <SkyArt variant="drought" seed={9} cell={3} speed={0.01} />
        <div className="panel-inner">
          <span className="panel-tag">LIVE · QUOTED BY THE DEPLOYED v{deployment.version} CONTRACT</span>
          <div style={{ marginTop: 10 }}>
            {ribbonDaily.length ? <RainRibbon series={ribbonDaily} threshold={trigger} kind={activePeril} replayKey={`${tId}-${trigger}-${ribbonYear}`} height={240} /> : <Loading label="Drawing the season…" />}
            <div className="small muted" style={{ margin: "8px 0 22px", display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              Real {season.location.name} season, drawn into your trigger line:
              <select aria-label="Illustration year" value={ribbonYear} onChange={(e) => setRibbonYear(Number(e.target.value))} style={{ width: "auto", padding: "5px 30px 5px 10px" }}>
                {Array.from({ length: 12 }, (_, i) => 2025 - i).map((y) => (
                  <option key={y}>{y}</option>
                ))}
              </select>
            </div>
      <div className="builder">
        <div className="card">
          <h3>Build your cover</h3>
          <label className="field">
            <span>1 · Location</span>
            <select value={locId} onChange={(e) => setLocId(e.target.value)}>
              {locations.map((l) => {
                const ok = l.seasons.some((s) => s.perils.some((p) => p.offered));
                return (
                  <option key={l.id} value={l.id} disabled={!ok}>
                    {l.name}, {l.country} {ok ? "" : "— not offered (sources disagree)"}
                  </option>
                );
              })}
            </select>
          </label>
          {offeredSeasonsHere.length > 1 && (
            <label className="field">
              <span>Season</span>
              <select value={season.id} onChange={(e) => setSeasonId(e.target.value)}>
                {offeredSeasonsHere.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </label>
          )}
          <label className="field">
            <span>2 · Peril</span>
            <div className="seg" role="group" aria-label="Peril">
              {(["drought", "flood"] as const).map((p) => (
                <button key={p} aria-pressed={activePeril === p} disabled={!availablePerils.includes(p)} onClick={() => setPeril(p)} title={availablePerils.includes(p) ? "" : "Not offered here: the two weather sources do not agree well enough"}>
                  {p === "drought" ? "Drought · pays on too little" : "Flood · pays on a deluge"}
                </button>
              ))}
            </div>
          </label>
          <p className="small muted" style={{ marginTop: -8 }}>
            {season.location.note} {activePeril === "drought" ? `Pays if the ${season.name.toLowerCase()} rainfall total is ${dir} your trigger.` : `Pays if the heaviest 3 days of the season reach ${dir} your trigger.`}
          </p>

          <label className="field">
            <span>3 · Trigger: {trigger} mm</span>
            <input type="range" min={0} max={sorted.length - 1} value={idx} onChange={(e) => setTrigIdx(Number(e.target.value))} aria-label="Trigger level" />
            <div className="small muted mono" style={{ display: "flex", justifyContent: "space-between" }}>
              <span>{sorted[0]} mm</span>
              <span>{activePeril === "drought" ? "easier to hit →" : "← easier to hit"}</span>
              <span>{sorted[sorted.length - 1]} mm</span>
            </div>
          </label>
          <label className="field">
            <span>4 · Payout (tUSD)</span>
            <input type="number" min="0" step="10" inputMode="decimal" value={payoutStr} onChange={(e) => setPayoutStr(e.target.value)} />
            {small && <span className="small" style={{ color: "var(--danger)", textTransform: "none", letterSpacing: 0 }}>Minimum payout is {fmtUsd(minPayout.data!, 0)} tUSD.</span>}
          </label>

          <label className="field">
            <span>Season to cover</span>
            <div className="seg" role="group" aria-label="Season mode">
              <button aria-pressed={mode === "forward"} onClick={() => setMode("forward")}>Live season</button>
              <button aria-pressed={mode === "replay"} disabled={!openReplays.length} onClick={() => setMode("replay")} title={openReplays.length ? "" : "No replay round is open for this season"}>Replay (testnet)</button>
            </div>
            {mode === "replay" && openReplays.length > 0 && (
              <select style={{ marginTop: 8 }} value={year ?? ""} onChange={(e) => setReplayYear(Number(e.target.value))}>
                {openReplays.map((y) => <option key={y}>{y}</option>)}
              </select>
            )}
          </label>
        </div>

        <div style={{ position: "sticky", top: 90 }}>
          <div className="card">
            <h3>
              <span>Your quote</span>
              {mode === "replay" && <ReplayTag />}
            </h3>
            {!year ? (
              <div className="note bad">
                No purchase window is open for this season right now. Cover must be bought at least 14 days before the season starts and no more than 400 days ahead. Try another place or season.
              </div>
            ) : quote.isLoading ? (
              <Loading label="Pricing on-chain…" />
            ) : quoteProblem ? (
              <div className="note bad" role="alert">
                {quoteProblem?.kind === "network" ? quoteProblem.message : <>The engine will not price this cover. {quoteProblem?.message}</>}
                {quoteProblem?.kind === "network" && <div style={{ marginTop: 10 }}><button className="btn ghost small" onClick={() => quote.refetch()}>Try again</button></div>}
              </div>
            ) : premium !== undefined && q ? (
              <>
                <div className="premium-box">
                  <div className="eyebrow">Premium</div>
                  <span key={tick} className="premium-num tick">{fmtUsd(premiumT ?? Number(premium) / 1e6)}</span> <span className="mono">tUSD</span>
                  <div className="small muted" style={{ position: "relative" }}>
                    for a {fmtUsd(payout, 0)} tUSD payout · {pct(q[3], 2)} of payout
                  </div>
                </div>
                <div className="hr" />
                <div className="eyebrow">Why this price</div>
                {parts && (
                  <>
                    <div className="stack-bar" role="img" aria-label="Premium breakdown">
                      <i style={{ flexBasis: `${Number(parts.p) / Number(parts.rate) * 100}%`, background: "var(--rain)" }} />
                      <i style={{ flexBasis: `${Number(parts.margin) / Number(parts.rate) * 100}%`, background: "var(--ochre)" }} />
                      <i style={{ flexBasis: `${Number(parts.loadingPart) / Number(parts.rate) * 100}%`, background: "var(--drought)" }} />
                    </div>
                    <div className="legend">
                      <span style={{ ["--c" as any]: "var(--rain)" }}>expected loss {pct(parts.p)}</span>
                      <span style={{ ["--c" as any]: "var(--ochre)" }}>uncertainty margin {pct(parts.margin)}</span>
                      <span style={{ ["--c" as any]: "var(--drought)" }}>loading {pct(parts.loadingPart)}</span>
                    </div>
                  </>
                )}
                <p className="small muted" style={{ marginTop: 10 }}>
                  In 35 years of data this trigger would have paid about {pct(q[1], 1)} of seasons. The margin covers how unsure that estimate is (± {pct(q[2], 1)}).
                </p>
                <div className="hr" />
                <div className="small">
                  <b>{season.location.name} · {season.name} {year}</b> {mode === "replay" && <ReplayTag />}
                  <br />
                  Season runs {fmtDate(start)} – {fmtDate(end - 86400)}.
                  {mode === "forward" && <> You can buy until {fmtDate(start - LEAD_TIME)}: a 14-day waiting period so nobody can buy cover on a storm they already see coming.</>}
                  {mode === "replay" && <> <b>Replay:</b> a finished historical season replayed on a test network so a payout can be shown end to end. Real recorded data, no real money.</>}
                </div>
                <div style={{ marginTop: 16 }}>
                  {!isConnected ? (
                    <p className="small muted">Connect a wallet (top right) to buy. You only need a little Arbitrum Sepolia ETH for gas; the buy button claims free test tUSD for you first.</p>
                  ) : (
                    <button className="btn block" disabled={buy.status === "pending" || small || payout === 0n} onClick={() => buy.run()}>
                      {buy.status === "pending" ? <><span className="spinner" /> {steps[steps.length - 1] ?? "Confirm in wallet…"}</> : chainId !== chain.id ? "Switch network & buy" : `Buy cover for ${fmtUsd(premium)} tUSD`}
                    </button>
                  )}
                  {isConnected && bal.data !== undefined && (
                    <div className="small muted mono" style={{ marginTop: 8 }}>Your balance: {fmtUsd(bal.data)} tUSD {bal.data < premium && "(the button claims free test tUSD first)"}</div>
                  )}
                  {buy.status === "error" && <div className="note bad small">{buy.error}</div>}
                  {buy.status === "done" && lastTx && (
                    <div className="note ok small">
                      Cover bought. <a href={explorerTx(lastTx)} target="_blank" rel="noreferrer">View transaction</a> · <Link to="/ledger">See it in the ledger</Link>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <Loading label="Pricing on-chain…" />
            )}
            <div className="small muted mono" style={{ marginTop: 12 }}>
              Priced by: {kind.data === "stylus" ? "Stylus (Rust/WASM) engine" : kind.data ? "Solidity fallback engine (Stylus activation is paused on Arbitrum Sepolia)" : "…"}
              <br />
              Now: {fmtDate(now)}
            </div>
          </div>
        </div>
      </div>
          </div>
        </div>
      </section>
      <div className="band tall" />
      <section className="sec flush">
        <div className="wrap nopad center" style={{ padding: "64px var(--pad) 44px" }}>
          <div className="kicker" style={{ justifyContent: "center" }}>How it works</div>
          <h2 style={{ maxWidth: "20ch", margin: "0 auto" }}>One season. Two data sources. A contract that settles.</h2>
        </div>
        <Features />
      </section>
      <div className="band" />
      <CtaBand />
    </>
  );
}
