import type { ReactNode } from "react";

export const Skeleton = ({ h = 18, w = "100%" }: { h?: number; w?: string | number }) => (
  <div className="skeleton" style={{ height: h, width: w }} aria-hidden />
);

export const Loading = ({ label = "Reading the chain…" }: { label?: string }) => (
  <div className="state" role="status">
    <span className="spinner" /> <span style={{ marginLeft: 8 }}>{label}</span>
  </div>
);

export const Empty = ({ title, children }: { title: string; children?: ReactNode }) => (
  <div className="state">
    <h3>{title}</h3>
    <div>{children}</div>
  </div>
);

export const ErrorBox = ({ title = "Something went wrong", detail, retry }: { title?: string; detail?: string; retry?: () => void }) => (
  <div className="state err" role="alert">
    <h3>{title}</h3>
    {detail && <p className="mono small">{detail}</p>}
    {retry && (
      <button className="btn ghost small" onClick={retry}>
        Try again
      </button>
    )}
  </div>
);

export const Stat = ({ k, v, s, mono }: { k: string; v: ReactNode; s?: ReactNode; mono?: boolean }) => (
  <div className="stat">
    <div className="k">{k}</div>
    <div className={`v${mono ? " mono" : ""}`}>{v}</div>
    {s && <div className="s">{s}</div>}
  </div>
);

export const ReplayTag = () => (
  <span className="tag replay" title="A historical season replayed on a test network. Not a live forward season.">
    Replay
  </span>
);
