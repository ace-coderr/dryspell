import test from "node:test";
import assert from "node:assert/strict";
import { fitGamma, fitGumbel, gammaCdf, gammaP, gumbelCdf, invertCdf, lnGamma, mulberry32 } from "./stats.ts";

const near = (a: number, b: number, tol: number) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);

test("lnGamma matches known values", () => {
  near(lnGamma(1), 0, 1e-9);
  near(lnGamma(5), Math.log(24), 1e-9);
  near(lnGamma(0.5), Math.log(Math.sqrt(Math.PI)), 1e-9);
});

test("gammaP: shape 1 is exponential, shape 2 closed form", () => {
  for (const x of [0.1, 0.5, 1, 3, 8]) {
    near(gammaP(1, x), 1 - Math.exp(-x), 1e-10);
    near(gammaP(2, x), 1 - Math.exp(-x) * (1 + x), 1e-10);
  }
  near(gammaP(5, 0), 0, 0);
});

test("gamma fit recovers parameters from a large sample", () => {
  const rnd = mulberry32(42);
  // sum of k exponentials ~ Gamma(k, scale)
  const k = 6;
  const scale = 40;
  const xs = Array.from({ length: 20000 }, () => {
    let s = 0;
    for (let i = 0; i < k; i++) s += -Math.log(1 - rnd()) * scale;
    return s;
  });
  const f = fitGamma(xs);
  near(f.shape, k, 0.25);
  near(f.scale, scale, 2);
});

test("gumbel fit recovers parameters from a large sample", () => {
  const rnd = mulberry32(7);
  const loc = 60;
  const scale = 12;
  const xs = Array.from({ length: 20000 }, () => loc - scale * Math.log(-Math.log(rnd())));
  const f = fitGumbel(xs);
  near(f.loc, loc, 0.6);
  near(f.scale, scale, 0.4);
  near(gumbelCdf(f, loc), Math.exp(-1), 0.01);
});

test("invertCdf round-trips", () => {
  const f = { shape: 4, scale: 25 };
  const x = invertCdf((v) => gammaCdf(f, v), 0.1, 0, 100);
  near(gammaCdf(f, x), 0.1, 1e-9);
});
