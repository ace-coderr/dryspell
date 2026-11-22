import { Link } from "react-router-dom";
import { useReadContract, useReadContracts } from "wagmi";
import { addr, chain } from "../lib/chain";
import { bookAbi, oracleAbi, vaultAbi } from "../lib/abi";
import { allSeasons, perilOf } from "../lib/data";
import { assess, calibrateFor, MAX_SPREAD_BPS_DEFAULT } from "../lib/contest";
import { interpolate } from "../lib/pricing";
import { fmtUsd } from "../lib/format";
import { useTween } from "../lib/tween";
import { SkyArt, type SkyVariant } from "./Sky";
import { ReplayTag } from "./States";

const C = { chainId: chain.id } as const;

function FloatCard({ title, tag, big, unit, meta }: { title: string; tag?: React.ReactNode; big: React.ReactNode; unit?: string; meta?: React.ReactNode }) {
  return (
    <div className="float-card">
      <div className="t"><span>{title}</span>{tag}</div>
      <div className="n">{big}{unit && <small>{unit}</small>}</div>
      {meta && <div className="m">{meta}</div>}
    </div>
  );
}

function Feature({ to, variant, seed, wide, title, text, children }: { to: string; variant: SkyVariant; seed: number; wide?: boolean; title: string; text: string; children: React.ReactNode }) {
  return (
    <Link to={to} className={`feature${wide ? " wide" : ""}`}>
      <div className="sky">
        <SkyArt variant={variant} seed={seed} cell={4} speed={0.03} />
        {children}
      </div>
      <div className="body">
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    </Link>
  );
}

const garissa = allSeasons.find((s) => s.location.id === "garissa" && s.id === "short")!;
const jodhpur = allSeasons.find((s) => s.location.id === "jodhpur")!;

export function Features() {
  // live reads from the deployed v3 contracts
  const vault = useReadContracts({
    contracts: [
      { address: addr.vault, abi: vaultAbi, functionName: "totalAssets", ...C },
      { address: addr.vault, abi: vaultAbi, functionName: "convertToAssets", args: [1_000_000_000n], ...C },
      { address: addr.vault, abi: vaultAbi, functionName: "utilizationBps", ...C },
    ],
    query: { refetchInterval: 15000 },
  });
  const round = useReadContract({ address: addr.oracle, abi: oracleAbi, functionName: "getRound", args: [(31n << 16n) | 2023n], ...C });
  const count = useReadContract({ address: addr.book, abi: bookAbi, functionName: "policyCount", ...C, query: { refetchInterval: 15000 } });
  const kind = useReadContract({ address: addr.book, abi: bookAbi, functionName: "engineKind", ...C });

  const assets = vault.data?.[0]?.result as bigint | undefined;
  const price = vault.data?.[1]?.result as bigint | undefined;
  const util = vault.data?.[2]?.result as bigint | undefined;
  const assetsT = useTween(assets !== undefined ? Number(assets) / 1e6 : undefined);
  const shareDelta = price !== undefined ? (Number(price) / 1e6 - 1) * 100 : undefined;

  // drought: the real fitted odds from the Jodhpur table
  const jd = perilOf(jodhpur, "drought");
  const jodhpurRow = jd.table.find((r) => r.level_mm === 142) ?? jd.table[4];

  // oracle: the real Garissa 2025 season, where the sources disagree most
  const g25 = garissa.history.find((h) => h.year === 2025)!;
  const gd = perilOf(garissa, "drought");
  const cal = calibrateFor(gd, g25.total_era5_mm, g25.total_power_mm);
  const a = assess("drought", 47, cal.eraX, cal.powX, MAX_SPREAD_BPS_DEFAULT);
  const gi = interpolate("drought", gd.table, 47);

  const r = round.data as any;
  const final = r && Number(r.state) === 3;

  return (
    <div className="features">
      <Feature to="/map" variant="drought" seed={11} title="Drought cover" text="Pays if a season's rainfall total ends at or below your trigger. Priced from 35 seasons of real data, with a margin for how unsure the odds are.">
        <FloatCard title="Jodhpur · monsoon" tag={<span className="chip up">35 seasons</span>} big={`${(jodhpurRow.p_ppm / 1e4).toFixed(1)}%`} unit="chance below" meta={<>{jodhpurRow.level_mm} mm trigger · mean {Math.round(jd.settlement_mean_mm)} mm</>} />
      </Feature>
      <Feature to="/ledger" variant="flood" seed={23} title="Flood cover" text="Pays if the heaviest three days of the season reach your trigger. A settled example is on the ledger, paid by the contract with nobody in the loop.">
        <FloatCard title="Garissa · short rains 2023" tag={<ReplayTag />} big={final ? (Number(r.max3X2) / 20).toFixed(1) : "…"} unit="mm in 3 days" meta={final ? <><span className="chip up">paid 500 tUSD</span> trigger 103 mm</> : "reading the oracle…"} />
      </Feature>
      <Feature to="/vault" variant="mixed" seed={5} title="Underwriter vault" text="Underwriters back every policy. Premiums raise the share price, payouts lower it, and collateral behind active cover cannot leave.">
        <FloatCard title="Pool assets" tag={shareDelta !== undefined ? <span className={`chip ${shareDelta >= 0 ? "up" : "down"}`}>{shareDelta >= 0 ? "▲" : "▼"} {Math.abs(shareDelta).toFixed(2)}%</span> : undefined} big={assetsT === undefined ? "…" : assetsT.toLocaleString("en-US", { maximumFractionDigits: 0 })} unit="tUSD" meta={util !== undefined ? <>{(Number(util) / 100).toFixed(1)}% reserved · share {(Number(price) / 1e6).toFixed(4)}</> : undefined} />
      </Feature>
      <Feature to="/monitor" variant="drought" seed={31} wide title="Two sources, one verdict" text="Every season is read from two independent datasets. When they land on opposite sides of a trigger, or too far apart, the policy goes to a resolver instead of paying automatically.">
        <FloatCard title="Garissa · short rains 2025" tag={a.contested ? <span className="chip down">contested</span> : <span className="chip up">agree</span>} big={`${(a.eraX / 10).toFixed(0)} vs ${(a.powX / 10).toFixed(0)}`} unit="mm, ERA5 vs POWER" meta={<>{(a.spreadBps / 100).toFixed(0)}% apart · a 47 mm trigger{gi ? ` (${(Number(gi.p) / 1e4).toFixed(1)}% odds)` : ""}</>} />
      </Feature>
      <Feature to="/agents" variant="flood" seed={47} wide title="Open to agents" text="A read-only MCP server lets an AI agent quote cover and read the pool and trigger status straight from the chain.">
        <FloatCard title="On-chain right now" tag={<span className="chip up">live</span>} big={count.data !== undefined ? String(count.data) : "…"} unit={count.data === 1n ? "policy" : "policies"} meta={<>engine: {kind.data === "stylus" ? "Stylus" : kind.data ? "Solidity fallback" : "…"} · {assets !== undefined ? `${fmtUsd(assets, 0)} tUSD` : "…"}</>} />
      </Feature>
    </div>
  );
}

export function CtaBand() {
  return (
    <section className="cta-band" aria-label="Get started">
      <SkyArt variant="gray" seed={7} cell={4} speed={0.012} landscape />
      <div className="wrap" style={{ width: "100%" }}>
        <h2>Cover the season before it starts.</h2>
        <div className="hero-actions">
          <button className="btn" onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}>Build your cover</button>
          <Link className="btn ghost nochev" to="/backtest">Read the backtest</Link>
        </div>
      </div>
    </section>
  );
}
