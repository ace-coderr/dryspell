import { useMemo, useState } from "react";
import { usePolicies, STATUS } from "../lib/policies";
import { addr, explorerAddress, explorerTx } from "../lib/chain";
import { fmtUsd, short } from "../lib/format";
import { seasonByLocSeasonId } from "../lib/data";
import { Loading, Empty, ErrorBox, ReplayTag, Stat } from "../components/States";
import { fmtDate } from "../lib/season";
import { Link } from "react-router-dom";

export default function Ledger() {
  const { rows, place, isLoading, error, logsError, refetch } = usePolicies();
  const [filter, setFilter] = useState<"all" | "live" | "replay">("all");
  const shown = useMemo(() => rows.filter((r) => (filter === "all" ? true : filter === "replay" ? r.replay : !r.replay)).sort((a, b) => b.id - a.id), [rows, filter]);
  const totals = useMemo(() => ({
    premium: rows.reduce((s, r) => s + r.premium, 0n),
    paid: rows.filter((r) => r.status === 2).reduce((s, r) => s + r.payout, 0n),
    active: rows.filter((r) => r.status === 1 || r.status === 5).reduce((s, r) => s + r.payout, 0n),
  }), [rows]);

  return (
    <div className="wrap">
      <div className="page-head reveal">
        <div className="eyebrow">Claims ledger</div>
        <h1>Every policy, trigger and payout</h1>
        <p className="lede">Read straight from the contracts. Each row links to the transactions on Arbiscan. Replay rows are historical seasons replayed on the test network for demonstration; they are labelled everywhere.</p>
      </div>

      {isLoading ? <Loading /> : error ? <ErrorBox title="Could not read the ledger" detail={String(error.message)} retry={refetch} /> : (
        <>
          <div className="grid g4 reveal d1">
            <Stat k="Policies" v={rows.length} s={`${rows.filter((r) => r.replay).length} replay · ${rows.filter((r) => !r.replay).length} live-season`} />
            <Stat k="Premiums paid" v={fmtUsd(totals.premium, 2)} s="tUSD, all policies" />
            <Stat k="Paid out" v={fmtUsd(totals.paid, 2)} s="tUSD to policyholders" />
            <Stat k="Still at risk" v={fmtUsd(totals.active, 2)} s="tUSD of active cover" />
          </div>
          <div className="seg" style={{ maxWidth: 380, margin: "22px 0 14px" }} role="group" aria-label="Filter">
            {(["all", "live", "replay"] as const).map((f) => (
              <button key={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>{f === "live" ? "live season" : f}</button>
            ))}
          </div>
          {logsError && <div className="note small">Transaction links could not be loaded right now; the policy data below is still read directly from the contract.</div>}
          {!shown.length ? (
            <Empty title="No policies here yet">
              <p>Be the first: <Link to="/">buy a cover</Link>.</p>
            </Empty>
          ) : (
            <div className="card scroll-x reveal d2" style={{ padding: 0 }}>
              <table className="data">
                <thead>
                  <tr><th>#</th><th>Cover</th><th>Peril &amp; trigger</th><th className="num">Premium</th><th className="num">Payout</th><th>Status</th><th>Transactions</th></tr>
                </thead>
                <tbody>
                  {shown.map((r) => {
                    const s = seasonByLocSeasonId(r.locSeasonId);
                    return (
                      <tr key={r.id}>
                        <td>{r.id}</td>
                        <td>
                          <b style={{ fontFamily: "var(--serif)", fontSize: "1rem" }}>{place(r)}</b> {r.replay && <ReplayTag />}
                          <div className="muted">{r.year} · holder <a href={explorerAddress(r.holder)} target="_blank" rel="noreferrer">{short(r.holder)}</a></div>
                          {s && <div className="muted">bought {fmtDate(r.purchasedAt)}</div>}
                        </td>
                        <td><span className={`tag ${r.peril}`}>{r.peril}</span> {r.peril === "drought" ? "≤" : "≥"} {r.trigger} mm{r.settlementX2 !== undefined && <div className="muted">settled at {(Number(r.settlementX2) / 20).toFixed(1)} mm</div>}</td>
                        <td className="num">{fmtUsd(r.premium)}</td>
                        <td className="num">{fmtUsd(r.payout)}</td>
                        <td><span className={`tag ${r.status === 2 ? "ok" : r.status === 1 || r.status === 5 ? "warn" : "dim"}`}>{STATUS[r.status]}</span>{r.contested && <div className="muted" title="The two weather sources fell on opposite sides of the trigger or differ by more than the allowed spread, so the resolver decides.">ERA5 {(Number(r.contested.era5X) / 10).toFixed(1)} mm vs POWER {(Number(r.contested.powerX) / 10).toFixed(1)} mm · {(Number(r.contested.spreadBps) / 100).toFixed(0)}% apart{r.contested.oppositeSides ? " · opposite sides" : ""}</div>}</td>
                        <td>
                          {r.buyTx ? <a href={explorerTx(r.buyTx)} target="_blank" rel="noreferrer">buy</a> : <span className="muted">buy</span>}
                          {r.settleTx && <> · <a href={explorerTx(r.settleTx)} target="_blank" rel="noreferrer">{r.status === 4 ? "refund" : "payout"}</a></>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="small muted" style={{ marginTop: 14 }}>
            Contract: <a href={explorerAddress(addr.book)} target="_blank" rel="noreferrer" className="mono">{addr.book}</a>
          </p>
        </>
      )}
    </div>
  );
}
