import { useMemo, useState } from "react";
import { useReadContract } from "wagmi";
import { addr, chain } from "../lib/chain";
import { engineAbi } from "../lib/abi";
import { locations, perilOf, regions, type PerilName, type Season } from "../lib/data";
import { breakdown, interpolate, type EngineParams } from "../lib/pricing";
import { pct } from "../lib/format";
import { Loading } from "../components/States";

export default function RiskMap() {
  const [locId, setLocId] = useState("jodhpur");
  const loc = locations.find((l) => l.id === locId)!;
  const [seasonId, setSeasonId] = useState(loc.seasons[0].id);
  const season = loc.seasons.find((s) => s.id === seasonId) ?? loc.seasons[0];
  const [peril, setPeril] = useState<PerilName>("drought");
  const pd = perilOf(season, peril);
  const [lvlIdx, setLvlIdx] = useState(4);
  const params = useReadContract({ address: addr.engine, abi: engineAbi, functionName: "params", chainId: chain.id });

  const rows = pd.table;
  const row = rows[Math.min(lvlIdx, rows.length - 1)];
  const ep: EngineParams | null = params.data ? { marginKBps: params.data[0], floorPpm: params.data[1], loadingBps: params.data[2], maxRatePpm: params.data[3], maxUtilBps: params.data[4] } : null;
  const parts = useMemo(() => {
    if (!ep) return null;
    const ip = interpolate(peril, rows, row.level_mm);
    return ip ? breakdown(ip.p, ip.se, ep) : null;
  }, [ep, rows, row, peril]);

  const pick = (id: string) => {
    setLocId(id);
    const l = locations.find((x) => x.id === id)!;
    setSeasonId(l.seasons[0].id);
    setLvlIdx(4);
  };

  return (
    <div className="wrap">
      <div className="page-head reveal">
        <div className="eyebrow">Risk map</div>
        <h1>Why the premium is what it is</h1>
        <p className="lede">Every price comes from real rainfall: 35 seasons (1991–2025) from two independent sources, fitted to a smooth curve, with a margin for how unsure that curve is. Pick a place and see the history behind it.</p>
      </div>

      <div className="map-grid">
        <div className="loc-list" role="list">
          {regions.map((reg) => (
            <div key={reg} style={{ display: "contents" }}>
              {locations.filter((l) => l.region === reg).map((l) => {
                const ok = l.seasons.some((s) => s.perils.some((p) => p.offered));
                return (
                  <button key={l.id} className="loc-item" aria-current={l.id === locId} onClick={() => pick(l.id)}>
                    <b>{l.name}</b>
                    <small>{l.country} · {reg}</small>
                    <small>{ok ? "cover offered" : "not offered: sources disagree"}</small>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        <div>
          <div className="card reveal">
            <h3>
              <span>{loc.name}, {loc.country}</span>
              <span className="mono small muted">{loc.lat.toFixed(2)}°, {loc.lon.toFixed(2)}°</span>
            </h3>
            <p className="muted">{loc.note}</p>
            <div className="grid g2">
              <label className="field">
                <span>Season</span>
                <select value={season.id} onChange={(e) => setSeasonId(e.target.value)}>
                  {loc.seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </label>
              <label className="field">
                <span>Peril</span>
                <div className="seg">
                  {(["drought", "flood"] as const).map((p) => (
                    <button key={p} aria-pressed={peril === p} onClick={() => setPeril(p)}>{p}</button>
                  ))}
                </div>
              </label>
            </div>
            <div className="grid g4">
              <div className="stat"><div className="k">Seasons of data</div><div className="v">{season.years}</div></div>
              <div className="stat"><div className="k">{peril === "drought" ? "Mean rainfall" : "Mean 3-day max"}</div><div className="v">{Math.round(pd.settlement_mean_mm)} mm</div><div className="s">± {Math.round(pd.settlement_stdev_mm)} mm</div></div>
              <div className="stat"><div className="k">Source agreement</div><div className="v">{pd.source_correlation.toFixed(2)}</div><div className="s"><span className={`tag ${pd.agreement === "high" ? "ok" : pd.agreement === "medium" ? "warn" : "bad"}`}>{pd.agreement}</span></div></div>
              <div className="stat"><div className="k">Status</div><div className="v" style={{ fontSize: "1.3rem" }}>{pd.offered ? "Offered" : "Not offered"}</div><div className="s">{pd.offered ? "sources agree enough" : "correlation below 0.40"}</div></div>
            </div>
            {!pd.offered && (
              <div className="note bad">
                <b>Not offered.</b> ERA5 and NASA POWER do not agree on year-to-year {peril === "drought" ? "rainfall totals" : "3-day extremes"} here (correlation {pd.source_correlation.toFixed(2)}). The oracle would mostly average noise, so a buyer could not trust that a payout tracks real rain. The data stay visible so you can see why.
              </div>
            )}
          </div>

          <div className="card reveal d1" style={{ marginTop: 22 }}>
            <h3>Thirty-five seasons, season by season</h3>
            <p className="small muted">Bars are the settlement value (the median of the two calibrated sources). Dots are each source alone: where they part, a payout could be disputed. The dashed line is the trigger you pick below.</p>
            <HistoryChart season={season} peril={peril} trigger={row.level_mm} />
          </div>

          <div className="card reveal d2" style={{ marginTop: 22 }}>
            <h3>Odds and price at each trigger</h3>
            <label className="field">
              <span>Trigger {row.level_mm} mm · {rows.length ? "move to compare" : ""}</span>
              <input type="range" min={0} max={rows.length - 1} value={Math.min(lvlIdx, rows.length - 1)} onChange={(e) => setLvlIdx(Number(e.target.value))} aria-label="Trigger" />
            </label>
            <div className="grid g3">
              <div className="stat"><div className="k">Fitted chance per season</div><div className="v">{pct(row.p_ppm)}</div><div className="s">smooth curve, used for pricing</div></div>
              <div className="stat"><div className="k">Actually happened</div><div className="v">{pct(row.p_empirical_ppm, 1)}</div><div className="s">{Math.round((row.p_empirical_ppm / 1e6) * season.years)} of {season.years} seasons</div></div>
              <div className="stat"><div className="k">Sources would split</div><div className="v">{pct(row.source_split_ppm, 0)}</div><div className="s">of seasons: one pays, one does not</div></div>
            </div>
            <hr className="hr" />
            {!ep ? <Loading label="Reading engine parameters…" /> : parts ? (
              <>
                <div className="eyebrow">Premium as a share of payout (engine parameters read from the chain)</div>
                <div className="stack-bar">
                  <i style={{ flexBasis: `${Number(parts.p) / Number(parts.rate) * 100}%`, background: "var(--rain)" }} />
                  <i style={{ flexBasis: `${Number(parts.margin) / Number(parts.rate) * 100}%`, background: "var(--ochre)" }} />
                  <i style={{ flexBasis: `${Number(parts.loadingPart) / Number(parts.rate) * 100}%`, background: "var(--drought)" }} />
                </div>
                <div className="legend">
                  <span style={{ ["--c" as any]: "var(--rain)" }}>expected loss {pct(parts.p)}</span>
                  <span style={{ ["--c" as any]: "var(--ochre)" }}>margin for uncertainty {pct(parts.margin)} (±{pct(parts.se)} × {Number(ep.marginKBps) / 10000})</span>
                  <span style={{ ["--c" as any]: "var(--drought)" }}>loading {pct(parts.loadingPart)}</span>
                </div>
                <p style={{ marginTop: 10 }}>
                  Total <b>{pct(parts.rate)}</b> of the payout{parts.refused ? " — above the engine's rate cap, so it refuses to sell this one." : "."} On a 1,000 tUSD payout that is <b>{(Number(parts.premium(1_000_000_000n)) / 1e6).toFixed(2)} tUSD</b>.
                </p>
              </>
            ) : <p className="muted">Outside the priced range.</p>}
            <div className="hr" />
            <div className="scroll-x">
              <table className="data">
                <thead><tr><th className="num">Trigger (mm)</th><th className="num">Fitted</th><th className="num">ERA5 alone</th><th className="num">POWER alone</th><th className="num">Happened</th><th className="num">± se</th></tr></thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.level_mm} onClick={() => setLvlIdx(i)} style={{ cursor: "pointer", background: i === lvlIdx ? "var(--paper-2)" : undefined }}>
                      <td className="num">{r.level_mm}</td><td className="num">{pct(r.p_ppm)}</td><td className="num">{pct(r.p_era5_ppm)}</td><td className="num">{pct(r.p_power_ppm)}</td><td className="num">{pct(r.p_empirical_ppm, 1)}</td><td className="num">{pct(r.se_ppm)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="small muted" style={{ marginTop: 10 }}>
              Method: {pd.distribution === "gamma" ? "Gamma fit to season totals" : "Gumbel fit to seasonal maximum 3-day rainfall"}. ERA5 is multiplied by {(pd.calibration_era5_ppm / 1e6).toFixed(3)} and NASA POWER by {(pd.calibration_power_ppm / 1e6).toFixed(3)} before the median, because the two sources differ structurally (published on-chain). About 35 seasons: tail odds carry real sampling error (the ± column).
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function HistoryChart({ season, peril, trigger }: { season: Season; peril: PerilName; trigger: number }) {
  const W = 800, H = 260, pad = { l: 44, r: 10, t: 14, b: 26 };
  const hist = season.history;
  const key = peril === "drought" ? "total" : "max3";
  const vals = hist.map((h) => ({ year: h.year, s: peril === "drought" ? h.total_settle_mm : h.max3_settle_mm, e: peril === "drought" ? h.total_era5_mm : h.max3_era5_mm, p: peril === "drought" ? h.total_power_mm : h.max3_power_mm }));
  const maxV = Math.max(trigger * 1.1, ...vals.flatMap((v) => [v.s, v.e, v.p]));
  const bw = (W - pad.l - pad.r) / vals.length;
  const y = (v: number) => H - pad.b - (v / maxV) * (H - pad.t - pad.b);
  const hit = (v: number) => (peril === "drought" ? v <= trigger : v >= trigger);
  return (
    <div className="ribbon-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Settlement value per season against the ${trigger} mm trigger`} data-key={key}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={pad.l} x2={W - pad.r} y1={y(f * maxV)} y2={y(f * maxV)} stroke="var(--rule)" strokeDasharray="2 4" />
            <text x={pad.l - 6} y={y(f * maxV) + 4} textAnchor="end" fontFamily="var(--mono)" fontSize="10" fill="var(--ink-3)">{Math.round(f * maxV)}</text>
          </g>
        ))}
        {vals.map((v, i) => {
          const x = pad.l + i * bw;
          return (
            <g key={v.year}>
              <rect x={x + 2} y={y(v.s)} width={bw - 4} height={H - pad.b - y(v.s)} fill={hit(v.s) ? "var(--drought)" : "var(--rain)"} opacity={hit(v.s) ? 0.95 : 0.55} style={{ transformOrigin: `${x}px ${H - pad.b}px`, animation: `rise .5s ${i * 0.015}s both` }}>
                <title>{`${v.year}: settlement ${v.s} mm · ERA5 ${v.e} · POWER ${v.p}${hit(v.s) ? " · would pay" : ""}`}</title>
              </rect>
              <circle cx={x + bw / 2} cy={y(v.e)} r={2.6} fill="var(--ink)" />
              <circle cx={x + bw / 2} cy={y(v.p)} r={2.6} fill="var(--ochre)" stroke="var(--ink)" strokeWidth="0.6" />
              {i % 5 === 0 && <text x={x + bw / 2} y={H - 8} textAnchor="middle" fontFamily="var(--mono)" fontSize="10" fill="var(--ink-3)">{v.year}</text>}
            </g>
          );
        })}
        <line x1={pad.l} x2={W - pad.r} y1={y(trigger)} y2={y(trigger)} stroke="var(--drought)" strokeWidth="2" strokeDasharray="7 5" />
        <text x={W - pad.r} y={y(trigger) - 5} textAnchor="end" fontFamily="var(--mono)" fontSize="11" fontWeight="600" fill="var(--drought)">trigger {trigger} mm</text>
      </svg>
      <div className="legend">
        <span style={{ ["--c" as any]: "var(--rain)" }}>settlement, no payout</span>
        <span style={{ ["--c" as any]: "var(--drought)" }}>settlement, would pay</span>
        <span style={{ ["--c" as any]: "var(--ink)" }}>ERA5 alone</span>
        <span style={{ ["--c" as any]: "var(--ochre)" }}>NASA POWER alone</span>
      </div>
    </div>
  );
}
