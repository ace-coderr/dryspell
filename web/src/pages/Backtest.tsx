import { useMemo, useState } from "react";
import { useReadContract } from "wagmi";
import { addr, chain } from "../lib/chain";
import { engineAbi } from "../lib/abi";
import { allSeasons, perilOf, type PerilName } from "../lib/data";
import { breakdown, interpolate, type EngineParams } from "../lib/pricing";
import { pct } from "../lib/format";
import { Loading } from "../components/States";

const offered = allSeasons.filter((s) => s.perils.some((p) => p.offered));
const usd = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 0 });

export default function Backtest() {
  const [key, setKey] = useState(`${offered.find((s) => s.location.id === "garissa" && s.id === "short")?.locSeasonId ?? offered[0].locSeasonId}`);
  const season = offered.find((s) => String(s.locSeasonId) === key) ?? offered[0];
  const availablePerils = season.perils.filter((p) => p.offered).map((p) => p.peril);
  const [peril, setPeril] = useState<PerilName>("drought");
  const kind: PerilName = availablePerils.includes(peril) ? peril : availablePerils[0];
  const pd = perilOf(season, kind);
  const levels = [...pd.table].sort((a, b) => a.level_mm - b.level_mm).map((r) => r.level_mm);
  const [levelIdx, setLevelIdx] = useState(4);
  const trigger = levels[Math.min(levelIdx, levels.length - 1)];
  const [payout, setPayout] = useState(1000);
  const params = useReadContract({ address: addr.engine, abi: engineAbi, functionName: "params", chainId: chain.id });

  const result = useMemo(() => {
    if (!params.data) return null;
    const ep: EngineParams = { marginKBps: params.data[0], floorPpm: params.data[1], loadingBps: params.data[2], maxRatePpm: params.data[3], maxUtilBps: params.data[4] };
    const ip = interpolate(kind, pd.table, trigger);
    if (!ip) return null;
    const b = breakdown(ip.p, ip.se, ep);
    const premium = Number(b.premium(BigInt(payout) * 1_000_000n)) / 1e6;
    const pays = (v: number) => (kind === "drought" ? v <= trigger : v >= trigger);
    let cum = 0;
    const rows = season.history.map((h) => {
      const s = kind === "drought" ? h.total_settle_mm : h.max3_settle_mm;
      const e = kind === "drought" ? h.total_era5_mm : h.max3_era5_mm;
      const p = kind === "drought" ? h.total_power_mm : h.max3_power_mm;
      const paid = pays(s);
      // each source alone would have decided differently from the settlement: this is the oracle's own basis risk
      const eraSays = pays(e * (pd.calibration_era5_ppm / 1e6));
      const powSays = pays(p * (pd.calibration_power_ppm / 1e6));
      const disagree = eraSays !== powSays;
      cum += (paid ? payout : 0) - premium;
      return { year: h.year, s, e, p, paid, disagree, eraSays, powSays, cum };
    });
    const paidYears = rows.filter((r) => r.paid).length;
    return { rows, premium, rate: b.rate, paidYears, n: rows.length, totalPremium: premium * rows.length, totalPaid: paidYears * payout, disagreeYears: rows.filter((r) => r.disagree).length, refused: b.refused, fitted: Number(ip.p) / 1e6 };
  }, [params.data, kind, pd, trigger, payout, season]);

  return (
    <div className="wrap">
      <div className="page-head reveal">
        <div className="eyebrow">Backtester · historical replay</div>
        <h1>What this cover would have done, 1991–2025</h1>
        <p className="lede">This is a <b>backtest</b>: real recorded rainfall replayed through the pricing rules. It is not a forecast and not a promise. It shows the hits and also the misses, including the years where the two weather sources would not have agreed.</p>
      </div>

      <div className="builder">
        <div className="card">
          <h3>Choose a cover to replay</h3>
          <label className="field">
            <span>Location and season</span>
            <select value={key} onChange={(e) => setKey(e.target.value)}>
              {offered.map((s) => <option key={s.locSeasonId} value={s.locSeasonId}>{s.location.name} · {s.name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Peril</span>
            <div className="seg">
              {(["drought", "flood"] as const).map((p) => <button key={p} aria-pressed={kind === p} disabled={!availablePerils.includes(p)} onClick={() => setPeril(p)}>{p}</button>)}
            </div>
          </label>
          <label className="field">
            <span>Trigger {trigger} mm</span>
            <input type="range" min={0} max={levels.length - 1} value={Math.min(levelIdx, levels.length - 1)} onChange={(e) => setLevelIdx(Number(e.target.value))} />
          </label>
          <label className="field">
            <span>Payout (tUSD)</span>
            <input type="number" min="10" step="100" value={payout} onChange={(e) => setPayout(Math.max(10, Number(e.target.value) || 10))} />
          </label>
          {!params.data ? <Loading label="Reading engine parameters…" /> : result && (
            <>
              <div className="hr" />
              <div className="stat"><div className="k">Premium the engine charges per season</div><div className="v">{usd(result.premium)} tUSD</div><div className="s">{(result.premium / payout * 100).toFixed(2)}% of payout</div></div>
              {result.refused && <div className="note bad small">The engine would refuse to sell this one (rate above its cap).</div>}
            </>
          )}
        </div>

        <div>
          {!result ? <Loading /> : (
            <>
              <div className="card reveal">
                <h3><span>Result over {result.n} seasons</span><span className="tag warn">backtest</span></h3>
                <div className="grid g4">
                  <div className="stat"><div className="k">Paid out</div><div className="v">{result.paidYears} of {result.n}</div><div className="s">{pct(result.paidYears / result.n * 1e6, 0)} of seasons · model said {pct(result.fitted * 1e6, 1)}</div></div>
                  <div className="stat"><div className="k">Premiums</div><div className="v">{usd(result.totalPremium)}</div><div className="s">tUSD over {result.n} seasons</div></div>
                  <div className="stat"><div className="k">Payouts</div><div className="v">{usd(result.totalPaid)}</div><div className="s">tUSD received</div></div>
                  <div className="stat"><div className="k">Loss ratio</div><div className="v">{result.totalPremium ? (result.totalPaid / result.totalPremium * 100).toFixed(0) : 0}%</div><div className="s">paid ÷ premiums (underwriters' view)</div></div>
                </div>
                <div className="note" style={{ marginTop: 16 }}>
                  <b>Read this honestly.</b> With about 35 seasons, the "paid out" frequency has real sampling noise, so it will not match the model's odds exactly. In <b>{result.disagreeYears}</b> of {result.n} seasons the two weather sources, taken alone, would have disagreed about whether to pay: those are the seasons where a payout could be disputed. And no gridded dataset sees a single farm: on a patchy storm the field can fail while the data say normal (a miss), or the reverse. That gap is <b>basis risk</b>, and it is why this is cover on the data, not on any one farm.
                </div>
              </div>

              <div className="card reveal d1" style={{ marginTop: 22 }}>
                <h3>Season by season</h3>
                <div className="scroll-x" style={{ maxHeight: 520, overflow: "auto" }}>
                  <table className="data">
                    <thead><tr><th>Year</th><th className="num">Settlement</th><th className="num">ERA5</th><th className="num">POWER</th><th>Outcome</th><th>Sources</th><th className="num">Net to buyer, cumulative</th></tr></thead>
                    <tbody>
                      {[...result.rows].reverse().map((r) => (
                        <tr key={r.year}>
                          <td>{r.year}</td>
                          <td className="num">{r.s.toFixed(1)} mm</td>
                          <td className="num">{r.e.toFixed(1)}</td>
                          <td className="num">{r.p.toFixed(1)}</td>
                          <td>{r.paid ? <span className="tag ok">paid {usd(payout)}</span> : <span className="tag dim">no payout</span>}</td>
                          <td>{r.disagree ? <span className="tag bad" title={`ERA5 alone: ${r.eraSays ? "pay" : "no pay"} · POWER alone: ${r.powSays ? "pay" : "no pay"}`}>split</span> : <span className="muted">agree</span>}</td>
                          <td className="num" style={{ color: r.cum >= 0 ? "var(--sage)" : "var(--ink-2)" }}>{r.cum >= 0 ? "+" : "−"}{usd(Math.abs(r.cum))}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
