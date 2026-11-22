import { useMemo, useState } from "react";
import { useReadContract } from "wagmi";
import { addr, chain } from "../lib/chain";
import { engineAbi, oracleAbi } from "../lib/abi";
import { allSeasons, perilOf, type PerilName } from "../lib/data";
import { breakdown, interpolate, type EngineParams } from "../lib/pricing";
import { pct } from "../lib/format";
import { Loading } from "../components/States";
import { assess, calibrateFor, MAX_SPREAD_BPS_DEFAULT } from "../lib/contest";

const offered = allSeasons.filter((s) => s.perils.some((p) => p.offered));
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
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
  const maxSpreadQ = useReadContract({ address: addr.oracle, abi: oracleAbi, functionName: "maxSpreadBps", chainId: chain.id });

  const result = useMemo(() => {
    if (!params.data) return null;
    const ep: EngineParams = { marginKBps: params.data[0], floorPpm: params.data[1], loadingBps: params.data[2], maxRatePpm: params.data[3], maxUtilBps: params.data[4] };
    const ip = interpolate(kind, pd.table, trigger);
    if (!ip) return null;
    const b = breakdown(ip.p, ip.se, ep);
    const premium = Number(b.premium(BigInt(payout) * 1_000_000n)) / 1e6;
    const pays = (v: number) => (kind === "drought" ? v <= trigger : v >= trigger);
    const maxSpread = maxSpreadQ.data !== undefined ? Number(maxSpreadQ.data) : MAX_SPREAD_BPS_DEFAULT;
    // the rule the contract applies: opposite sides of the trigger, or too far apart, means the resolver decides
    const rows = season.history.map((h) => {
      const sMed = kind === "drought" ? h.total_settle_mm : h.max3_settle_mm;
      const eRaw = kind === "drought" ? h.total_era5_mm : h.max3_era5_mm;
      const pRaw = kind === "drought" ? h.total_power_mm : h.max3_power_mm;
      const { eraX, powX } = calibrateFor(pd, eRaw, pRaw);
      const as = assess(kind, trigger, eraX, powX, maxSpread);
      const outcome: "paid" | "none" | "contested" = as.contested ? "contested" : pays(sMed) ? "paid" : "none";
      return { year: h.year, s: sMed, e: eRaw, p: pRaw, as, outcome };
    });
    const nPaid = rows.filter((r) => r.outcome === "paid").length;
    const nContested = rows.filter((r) => r.outcome === "contested").length;
    const nOpposite = rows.filter((r) => r.as.opposite).length;
    const nSpread = rows.filter((r) => !r.as.opposite && r.as.contested).length;
    // contested seasons are decided by the resolver: the buyer's result if it always declines, and if it always pays
    let low = 0;
    let high = 0;
    const withCum = rows.map((r) => {
      low += (r.outcome === "paid" ? payout : 0) - premium;
      high += (r.outcome === "paid" || r.outcome === "contested" ? payout : 0) - premium;
      return { ...r, cumLow: low, cumHigh: high };
    });
    return { rows: withCum, premium, rate: b.rate, nPaid, nContested, nOpposite, nSpread, n: rows.length, totalPremium: premium * rows.length, refused: b.refused, fitted: Number(ip.p) / 1e6, maxSpread };
  }, [params.data, maxSpreadQ.data, kind, pd, trigger, payout, season]);

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
                  <div className="stat"><div className="k">Paid automatically</div><div className="v">{result.nPaid} of {result.n}</div><div className="s">both sources agree · model said {pct(result.fitted * 1e6, 1)}</div></div>
                  <div className="stat"><div className="k">Contested</div><div className="v" style={{ color: "var(--ochre)" }}>{result.nContested} of {result.n}</div><div className="s">{result.nOpposite} opposite sides · {result.nSpread} too far apart (&gt;{result.maxSpread / 100}%)</div></div>
                  <div className="stat"><div className="k">Premiums</div><div className="v">{usd(result.totalPremium)}</div><div className="s">tUSD over {result.n} seasons</div></div>
                  <div className="stat"><div className="k">Buyer's net result</div><div className="v" style={{ fontSize: "1.4rem" }}>{signed(result.rows[result.rows.length - 1].cumLow)} to {signed(result.rows[result.rows.length - 1].cumHigh)}</div><div className="s">tUSD: resolver always declines … always pays</div></div>
                </div>
                <div className="note" style={{ marginTop: 16 }}>
                  <b>The disagreement rule.</b> If ERA5 and NASA POWER fall on opposite sides of the trigger, or are more than {result.maxSpread / 100}% of their mean apart, the policy does not pay automatically: the named resolver rules. In this replay that is <b>{result.nContested}</b> of {result.n} seasons for this cover, which is a real cost of using two imperfect sources: slower and less automatic settlement exactly when the data are ambiguous. And no gridded dataset sees a single farm: on a patchy storm the field can fail while the data say normal (a miss), or the reverse. That gap is <b>basis risk</b>, and it is why this is cover on the data, not on any one farm.
                </div>
              </div>

              <div className="card reveal d1" style={{ marginTop: 22 }}>
                <h3>Season by season</h3>
                <div className="scroll-x" style={{ maxHeight: 520, overflow: "auto" }}>
                  <table className="data stack">
                    <thead><tr><th>Year</th><th className="num">ERA5 (calibrated)</th><th className="num">POWER (calibrated)</th><th className="num">Spread</th><th>Outcome</th><th className="num">Net to buyer, cumulative</th></tr></thead>
                    <tbody>
                      {[...result.rows].reverse().map((r) => (
                        <tr key={r.year}>
                          <td data-label="Year">{r.year}</td>
                          <td className="num" data-label="ERA5">{(r.as.eraX / 10).toFixed(1)} mm {r.as.eraSays ? "▲pay" : ""}</td>
                          <td className="num" data-label="POWER">{(r.as.powX / 10).toFixed(1)} mm {r.as.powSays ? "▲pay" : ""}</td>
                          <td className="num" data-label="Spread">{(r.as.spreadBps / 100).toFixed(0)}%</td>
                          <td data-label="Outcome">{r.outcome === "paid" ? <span className="tag ok">paid {usd(payout)}</span> : r.outcome === "contested" ? <span className="tag warn" title={r.as.opposite ? "sources on opposite sides of the trigger" : "sources too far apart"}>contested{r.as.opposite ? " · opposite sides" : " · wide spread"}</span> : <span className="tag dim">no payout</span>}</td>
                          <td className="num" data-label="Net to buyer">{signed(r.cumLow)}{r.cumLow !== r.cumHigh ? ` … ${signed(r.cumHigh)}` : ""}</td>
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
