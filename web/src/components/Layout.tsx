import { useState } from "react";
import { NavLink, Outlet, Link, useLocation } from "react-router-dom";
import { useEffect } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { chain, addr, explorerAddress, deployment } from "../lib/chain";
import { useEngineKind } from "../lib/hooks";
import { short } from "../lib/format";

const links = [
  ["/", "Buy cover"],
  ["/vault", "Vault"],
  ["/map", "Risk map"],
  ["/monitor", "Triggers"],
  ["/ledger", "Ledger"],
  ["/backtest", "Backtest"],
  ["/agents", "Agents"],
] as const;

export function EngineBadge() {
  const { data, isLoading, isError } = useEngineKind();
  const stylus = data === "stylus";
  const label = isLoading ? "reading engine…" : isError ? "engine unreadable" : stylus ? "Engine: Stylus (Rust/WASM)" : "Engine: Solidity fallback (Stylus paused)";
  return (
    <span className={`engine ${isLoading ? "load" : stylus ? "stylus" : ""}`} title="Read from the deployed PolicyBook: engine.engineKind(). Stylus is only shown if the chain says so.">
      <i /> {label}
    </span>
  );
}

function WalletButton() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  if (!isConnected)
    return (
      <button className="btn small" disabled={isPending} onClick={() => connect({ connector: connectors[0], chainId: chain.id })} title={error?.message}>
        {isPending ? "Connecting…" : "Connect wallet"}
      </button>
    );
  if (chainId !== chain.id)
    return (
      <button className="btn small" disabled={switching} onClick={() => switchChain({ chainId: chain.id })}>
        {switching ? "Switching…" : "Switch to Arbitrum Sepolia"}
      </button>
    );
  return (
    <button className="btn ghost small" onClick={() => disconnect()} title="Disconnect">
      {short(address!)}
    </button>
  );
}

export function Layout() {
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    setOpen(false);
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <div className="strip">
        <div className="wrap">
          <span>Parametric weather cover · Arbitrum Sepolia testnet · play money only</span>
          <EngineBadge />
        </div>
      </div>
      <header className="mast">
        <div className="wrap">
          <Link to="/" className="brand" aria-label="Dryspell home">
            Dryspell <small>weather cover</small>
          </Link>
          <nav className={`main${open ? " open" : ""}`} aria-label="Main">
            {links.map(([to, label]) => (
              <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="right">
            <WalletButton />
            <button className="btn ghost small menu-btn" aria-expanded={open} aria-label="Menu" onClick={() => setOpen((o) => !o)}>
              {open ? "Close" : "Menu"}
            </button>
          </div>
        </div>
      </header>
      <main id="main">
        <Outlet />
      </main>
      <Footer />
    </>
  );
}

function Footer() {
  const { data } = useEngineKind();
  return (
    <footer>
      <div className="wrap">
        <div className="cols">
          <div>
            <h4>Dryspell</h4>
            <p style={{ maxWidth: "36ch" }}>Rain-based cover for farms and communities. Priced on-chain, paid out automatically when real weather data crosses the trigger. No claims form, no adjuster.</p>
            <p className="small muted">Testnet only. TestUSD is play money with no value.</p>
          </div>
          <div>
            <h4>App</h4>
            <ul>
              {links.map(([to, label]) => (
                <li key={to}>
                  <Link to={to}>{label}</Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4>Contracts · Arbiscan</h4>
            <ul className="mono small">
              <li><a href={explorerAddress(addr.book)} target="_blank" rel="noreferrer">PolicyBook</a></li>
              <li><a href={explorerAddress(addr.vault)} target="_blank" rel="noreferrer">UnderwriterVault</a></li>
              <li><a href={explorerAddress(addr.oracle)} target="_blank" rel="noreferrer">WeatherOracle</a></li>
              <li><a href={explorerAddress(addr.engine)} target="_blank" rel="noreferrer">Engine ({data === "stylus" ? "Stylus" : "Solidity fallback"})</a></li>
              <li><a href={explorerAddress(addr.token)} target="_blank" rel="noreferrer">TestUSD</a></li>
            </ul>
          </div>
          <div>
            <h4>Data &amp; source</h4>
            <ul className="small">
              <li><a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Weather data by Open-Meteo.com</a> (CC BY 4.0)</li>
              <li>ERA5 © Copernicus Climate Change Service</li>
              <li><a href="https://power.larc.nasa.gov/" target="_blank" rel="noreferrer">NASA POWER</a></li>
              <li><a href="https://github.com/ace-coderr/dryspell" target="_blank" rel="noreferrer">Source code</a></li>
            </ul>
          </div>
        </div>
        <div className="fine">
          Engine mode is read live from the contract (<code>{deployment.engineMode}</code> at deployment). Weather data are gridded products tens of kilometres wide: cover pays on the data, not on any one farm (basis risk). See the Backtest page for where it would have missed.
        </div>
      </div>
    </footer>
  );
}
