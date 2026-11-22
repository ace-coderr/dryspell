import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { addr, chain, deployment, explorerAddress } from "../lib/chain";
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
  const label = isLoading ? "reading engine…" : isError ? "engine unreadable" : stylus ? "Engine: Stylus (Rust/WASM)" : "Engine: Solidity fallback";
  return (
    <span className={`engine ${isLoading ? "load" : stylus ? "stylus" : ""}`} title="Read from the deployed PolicyBook: engine.engineKind(). Stylus is only shown if the chain says so. Stylus activation is paused on Arbitrum Sepolia.">
      <i /> {label}
    </span>
  );
}

export const Logo = ({ size = 26 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden>
    <rect width="32" height="32" rx="9" fill="#fafaf7" />
    <path d="M5 21c3.6-8.4 6.6-8.4 9.6-2.8s6.4 4.6 12.4-7" fill="none" stroke="#0a0a0a" strokeWidth="2.6" strokeLinecap="round" />
    <path d="M5 26h22" stroke="#ff7a2f" strokeWidth="2.2" strokeLinecap="round" />
  </svg>
);

/** the navbar pill: becomes the real connected-wallet pill with the address once connected */
function WalletPill() {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending, error } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  if (!isConnected)
    return (
      <button className="wallet-pill cta" disabled={isPending} onClick={() => connect({ connector: connectors[0], chainId: chain.id })} title={error?.message}>
        {isPending ? "Connecting…" : "Connect Wallet"}
      </button>
    );
  if (chainId !== chain.id)
    return (
      <button className="wallet-pill warn" disabled={switching} onClick={() => switchChain({ chainId: chain.id })}>
        {switching ? "Switching…" : "Switch to Arbitrum Sepolia"}
      </button>
    );
  return (
    <button className="wallet-pill on" onClick={() => disconnect()} title={`${address} · click to disconnect`}>
      <i /> {short(address!)}
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
      <div className="frame">
        <div className="inner">
          <div className="strip">
            <div className="wrap">
              <span>Parametric weather cover · Arbitrum Sepolia testnet · play money only</span>
              <EngineBadge />
            </div>
          </div>
          <header className="mast">
            <div className="wrap">
              <Link to="/" className="brand" aria-label="Dryspell home">
                <Logo /> Dryspell
              </Link>
              <nav className={`main${open ? " open" : ""}`} aria-label="Main">
                {links.map(([to, label]) => (
                  <NavLink key={to} to={to} end={to === "/"} className={({ isActive }) => (isActive ? "active" : "")}>
                    {label}
                  </NavLink>
                ))}
              </nav>
              <div className="right">
                <WalletPill />
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
        </div>
      </div>
    </>
  );
}

function Footer() {
  const { data } = useEngineKind();
  const ext = { target: "_blank", rel: "noreferrer" } as const;
  return (
    <footer>
      <div className="band" />
      <div className="wrap">
        <div className="f-top">
          <div className="f-brand">
            <Link to="/" className="brand" aria-label="Dryspell home">
              <Logo /> Dryspell
            </Link>
            <p>Rain-based cover for farms and communities: priced on-chain, paid out automatically when real weather data crosses the trigger.</p>
          </div>
          <EngineBadge />
        </div>
        <div className="f-cols">
          <div>
            <h4>Product</h4>
            <ul>
              {links.map(([to, label]) => (
                <li key={to}>
                  <Link to={to}>{label}</Link>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <h4>Contracts (v{deployment.version})</h4>
            <ul>
              <li><a href={explorerAddress(addr.book)} {...ext}>PolicyBook</a></li>
              <li><a href={explorerAddress(addr.vault)} {...ext}>UnderwriterVault</a></li>
              <li><a href={explorerAddress(addr.oracle)} {...ext}>WeatherOracle</a></li>
              <li><a href={explorerAddress(addr.engine)} {...ext}>Engine ({data === "stylus" ? "Stylus" : "Solidity fallback"})</a></li>
              <li><a href={explorerAddress(addr.token)} {...ext}>TestUSD</a></li>
            </ul>
          </div>
          <div>
            <h4>Data</h4>
            <ul>
              <li>
                <a href="https://open-meteo.com/" {...ext}>Open-Meteo</a>
                <span>Weather data by Open-Meteo.com, CC BY 4.0 · ERA5 © Copernicus Climate Change Service</span>
              </li>
              <li><a href="https://power.larc.nasa.gov/" {...ext}>NASA POWER</a></li>
              <li><a href="https://github.com/ace-coderr/dryspell" {...ext}>Source on GitHub</a></li>
            </ul>
          </div>
        </div>
        <div className="f-bar">
          <span>© 2026 Dryspell</span>
          <span>Testnet only, TestUSD has no value</span>
        </div>
      </div>
    </footer>
  );
}
