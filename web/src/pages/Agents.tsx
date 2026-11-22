import { useReadContracts } from "wagmi";
import { addr, chain, explorerAddress } from "../lib/chain";
import { bookAbi, oracleAbi, vaultAbi } from "../lib/abi";
import { fmtUsd } from "../lib/format";
import { Loading, Stat, ErrorBox } from "../components/States";

const tools = [
  ["quote_cover", "Price a cover: location, peril, season year, trigger, payout. Returns premium, odds, margin and whether the engine would sell it."],
  ["list_policies", "List policies with status, trigger, payout and whether each is a Replay."],
  ["read_vault", "Pool assets, utilisation, share value, exposure by region and peril."],
  ["read_trigger_status", "Oracle state of a covered season: report, dispute window countdown, final values."],
];

export default function Agents() {
  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useReadContracts({
    contracts: [
      { address: addr.book, abi: bookAbi, functionName: "engineKind", chainId: chain.id },
      { address: addr.book, abi: bookAbi, functionName: "policyCount", chainId: chain.id },
      { address: addr.vault, abi: vaultAbi, functionName: "totalAssets", chainId: chain.id },
      { address: addr.oracle, abi: oracleAbi, functionName: "resolver", chainId: chain.id },
      { address: addr.book, abi: bookAbi, functionName: "paused", chainId: chain.id },
    ],
    query: { refetchInterval: 10_000 },
  });
  return (
    <div className="wrap">
      <div className="page-head reveal">
        <div className="eyebrow">Agents · MCP server</div>
        <h1>Let an AI agent read the book</h1>
        <p className="lede">Dryspell ships a Model Context Protocol server so an agent (a chat assistant, a research bot, a treasury script) can quote cover and read pool and trigger status straight from the chain. It is <b>read-only by default</b> and runs on your own machine.</p>
      </div>

      <div className="grid g2">
        <div className="card reveal d1">
          <h3>Tools</h3>
          <table className="data">
            <tbody>{tools.map(([n, d]) => <tr key={n}><td className="mono" style={{ whiteSpace: "nowrap" }}><b>{n}</b></td><td style={{ fontFamily: "var(--text)", fontSize: "1rem" }}>{d}</td></tr>)}</tbody>
          </table>
          <div className="note small">The server never holds a key and has no write tools. Anything that spends tUSD stays a human-signed action in this app.</div>
        </div>
        <div className="card reveal d2">
          <h3>Set it up</h3>
          <ol style={{ paddingLeft: 20 }}>
            <li>Clone the repository and run <code>pnpm install</code>.</li>
            <li>Build the server: <code>pnpm --filter @dryspell/mcp build</code>.</li>
            <li>Add it to your MCP client with the absolute path, or run <code>claude mcp add dryspell -- node /absolute/path/to/dryspell/mcp/dist/index.js</code>:</li>
          </ol>
          <pre className="mono small" style={{ background: "var(--paper-2)", padding: 12, border: "1px solid var(--rule)", overflow: "auto" }}>{`{
  "mcpServers": {
    "dryspell": {
      "command": "node",
      "args": ["/absolute/path/to/dryspell/mcp/dist/index.js"]
    }
  }
}`}</pre>
          <p className="small muted">It reads the same contracts as this page, on Arbitrum Sepolia. It runs locally and is not hosted here: GitHub Pages only serves static files.</p>
        </div>
      </div>

      <div className="card reveal" style={{ marginTop: 22 }}>
        <h3>Live status of what the server reads <span className="small muted mono">updated {dataUpdatedAt ? new Date(dataUpdatedAt).toLocaleTimeString() : "…"}</span></h3>
        {isLoading ? <Loading /> : isError ? <ErrorBox title="Chain unreachable" detail={error?.message} retry={() => refetch()} /> : (
          <div className="grid g4">
            <Stat k="Engine mode" v={String(data?.[0].result ?? "?")} mono s={data?.[0].result === "stylus" ? "Rust/WASM on Stylus" : "Stylus activation is paused, fallback in use"} />
            <Stat k="Policies" v={String(data?.[1].result ?? "?")} s={data?.[4].result ? "sales paused" : "sales open"} />
            <Stat k="Vault assets" v={data?.[2].result !== undefined ? fmtUsd(data[2].result as bigint, 0) : "?"} s="tUSD" />
            <Stat k="Resolver" v={String(data?.[3].result ?? "?").slice(0, 8) + "…"} mono s={<a href={explorerAddress(String(data?.[3].result))} target="_blank" rel="noreferrer">on Arbiscan</a>} />
          </div>
        )}
        <p className="small muted" style={{ marginTop: 12 }}>This is the chain state the MCP server answers from. The local server process itself cannot be pinged from a static site, so this page shows the data it serves and not a heartbeat of your local process.</p>
      </div>
    </div>
  );
}
