// Small, dependency-free statistics used to turn 35 seasons of rainfall into
// smooth exceedance probabilities.
//   - seasonal rainfall totals  -> Gamma distribution (standard in hydrology)
//   - maximum 3-day rainfall    -> Gumbel (EV1) distribution

export const EULER_GAMMA = 0.5772156649015329;

// Lanczos approximation of ln Gamma(x)
export function lnGamma(x: number): number {
  const c = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5,
  ];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j++) ser += c[j] / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}

// Regularised lower incomplete gamma P(a, x)
export function gammaP(a: number, x: number): number {
  if (x <= 0) return 0;
  const gln = lnGamma(a);
  if (x < a + 1) {
    let ap = a;
    let sum = 1 / a;
    let del = sum;
    for (let n = 0; n < 500; n++) {
      ap += 1;
      del *= x / ap;
      sum += del;
      if (Math.abs(del) < Math.abs(sum) * 1e-14) break;
    }
    return sum * Math.exp(-x + a * Math.log(x) - gln);
  }
  // continued fraction for Q(a, x)
  const tiny = 1e-300;
  let b = x + 1 - a;
  let c = 1 / tiny;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < tiny) d = tiny;
    c = b + an / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gln) * h;
}

export interface GammaFit {
  shape: number;
  scale: number;
}

// Maximum-likelihood gamma fit using the Thom/Greenwood approximation for the shape.
export function fitGamma(xs: number[]): GammaFit {
  const n = xs.length;
  const mean = xs.reduce((s, v) => s + v, 0) / n;
  const floor = Math.max(1e-6, mean * 1e-6);
  const meanLog = xs.reduce((s, v) => s + Math.log(Math.max(v, floor)), 0) / n;
  const A = Math.log(mean) - meanLog;
  const shape = (1 + Math.sqrt(1 + (4 * A) / 3)) / (4 * A);
  return { shape, scale: mean / shape };
}

export const gammaCdf = (f: GammaFit, x: number) => gammaP(f.shape, x / f.scale);

export interface GumbelFit {
  loc: number;
  scale: number;
}

// Gumbel fit by L-moments (robust for short samples)
export function fitGumbel(xs: number[]): GumbelFit {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  let b0 = 0;
  let b1 = 0;
  for (let i = 0; i < n; i++) {
    b0 += s[i];
    b1 += (i / (n - 1)) * s[i];
  }
  b0 /= n;
  b1 /= n;
  const l1 = b0;
  const l2 = 2 * b1 - b0;
  const scale = l2 / Math.LN2;
  return { loc: l1 - EULER_GAMMA * scale, scale };
}

export const gumbelCdf = (f: GumbelFit, x: number) => Math.exp(-Math.exp(-(x - f.loc) / f.scale));

// Invert a monotone CDF by bisection
export function invertCdf(cdf: (x: number) => number, p: number, lo: number, hi: number): number {
  let a = lo;
  let b = hi;
  while (cdf(b) < p) b *= 2;
  for (let i = 0; i < 200; i++) {
    const m = (a + b) / 2;
    if (cdf(m) < p) a = m;
    else b = m;
  }
  return (a + b) / 2;
}

export function mean(xs: number[]): number {
  return xs.reduce((s, v) => s + v, 0) / xs.length;
}

export function stdev(xs: number[]): number {
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, xs.length - 1));
}

export function pearson(a: number[], b: number[]): number {
  const ma = mean(a);
  const mb = mean(b);
  let sab = 0;
  let saa = 0;
  let sbb = 0;
  for (let i = 0; i < a.length; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return sab / Math.sqrt(saa * sbb);
}

// Kolmogorov-Smirnov distance between the empirical and a fitted CDF
export function ksDistance(xs: number[], cdf: (x: number) => number): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  let d = 0;
  for (let i = 0; i < n; i++) {
    const F = cdf(s[i]);
    d = Math.max(d, Math.abs(F - i / n), Math.abs(F - (i + 1) / n));
  }
  return d;
}

// Deterministic PRNG so the generated JSON is reproducible
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
