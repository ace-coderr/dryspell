import { lazy, Suspense } from "react";
import { Route, Routes, Link } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Loading, Empty } from "./components/States";
import Builder from "./pages/Builder";

const Vault = lazy(() => import("./pages/Vault"));
const RiskMap = lazy(() => import("./pages/RiskMap"));
const Monitor = lazy(() => import("./pages/Monitor"));
const Ledger = lazy(() => import("./pages/Ledger"));
const Backtest = lazy(() => import("./pages/Backtest"));
const Agents = lazy(() => import("./pages/Agents"));

export default function App() {
  return (
    <Suspense fallback={<div className="wrap" style={{ padding: "60px 20px" }}><Loading label="Loading…" /></div>}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Builder />} />
          <Route path="vault" element={<Vault />} />
          <Route path="map" element={<RiskMap />} />
          <Route path="monitor" element={<Monitor />} />
          <Route path="ledger" element={<Ledger />} />
          <Route path="backtest" element={<Backtest />} />
          <Route path="agents" element={<Agents />} />
          <Route
            path="*"
            element={
              <div className="wrap" style={{ padding: "60px 20px" }}>
                <Empty title="That page does not exist">
                  <Link to="/">Back to the cover builder</Link>
                </Empty>
              </div>
            }
          />
        </Route>
      </Routes>
    </Suspense>
  );
}
