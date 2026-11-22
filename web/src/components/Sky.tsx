import { useEffect, useRef } from "react";

// Original procedural art: dithered pixel clouds drawn from layered value noise and an ordered (Bayer) dither.
// No image files are used; everything is computed here. Drifts slowly, pauses when off-screen or hidden,
// and draws a single still frame when the visitor prefers reduced motion.

export type SkyVariant = "drought" | "flood" | "mixed" | "gray";
type RGB = [number, number, number];

interface Palette {
  skyTop: RGB;
  skyMid: RGB;
  skyBottom: RGB;
  cloudLight: RGB;
  cloudMid: RGB;
  cloudDark: RGB;
  rock?: [RGB, RGB];
}

const PALETTES: Record<SkyVariant, Palette> = {
  // deep ember: brown-orange, no highlights
  drought: { skyTop: [22, 14, 14], skyMid: [58, 30, 22], skyBottom: [96, 52, 30], cloudLight: [128, 78, 48], cloudMid: [92, 52, 34], cloudDark: [58, 34, 26] },
  // deep slate-teal
  flood: { skyTop: [10, 19, 23], skyMid: [18, 44, 50], skyBottom: [30, 72, 76], cloudLight: [66, 108, 110], cloudMid: [40, 78, 84], cloudDark: [22, 48, 56] },
  // slate with a muted amber trace
  mixed: { skyTop: [15, 26, 30], skyMid: [30, 56, 58], skyBottom: [56, 80, 74], cloudLight: [112, 96, 64], cloudMid: [76, 70, 52], cloudDark: [42, 48, 44] },
  gray: { skyTop: [18, 18, 19], skyMid: [40, 40, 42], skyBottom: [66, 66, 68], cloudLight: [104, 104, 106], cloudMid: [72, 72, 74], cloudDark: [42, 42, 44], rock: [[16, 16, 17], [44, 44, 46]] },
};

const hash = (x: number, y: number, s: number) => {
  let h = (x * 374761393 + y * 668265263 + s * 982451653) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
};
function vnoise(x: number, y: number, s: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, s: number) {
  let t = 0;
  let a = 0.5;
  let f = 1;
  for (let o = 0; o < 5; o++) {
    t += a * vnoise(x * f, y * f, s + o);
    f *= 2;
    a *= 0.5;
  }
  return t;
}
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function render(ctx: CanvasRenderingContext2D, w: number, h: number, t: number, p: Palette, seed: number, landscape: boolean) {
  const img = ctx.createImageData(w, h);
  const px = img.data;
  const aspect = w / h;
  for (let y = 0; y < h; y++) {
    const fy = y / h;
    const sky = fy < 0.5 ? mix(p.skyTop, p.skyMid, fy / 0.5) : mix(p.skyMid, p.skyBottom, (fy - 0.5) / 0.5);
    for (let x = 0; x < w; x++) {
      const nx = (x / w) * 3.2 * aspect + t;
      const ny = fy * 3.2;
      const dither = (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * 0.11;
      let col: RGB = sky;
      const d = fbm(nx, ny, seed) + dither - (landscape ? 0.02 : 0);
      if (d > 0.66) col = p.cloudLight;
      else if (d > 0.57) col = p.cloudMid;
      else if (d > 0.5) col = p.cloudDark;
      if (landscape && p.rock) {
        const ridge = 0.6 + 0.3 * fbm((x / w) * 2.4 * aspect + seed, 0, seed + 9) - 0.1 * (x / w < 0.5 ? 1 - x / w : x / w);
        const rockNoise = fbm((x / w) * 9 * aspect, fy * 9, seed + 4) + dither;
        if (fy > ridge) col = rockNoise > 0.55 ? p.rock[1] : p.rock[0];
      }
      const i = (y * w + x) * 4;
      px[i] = col[0];
      px[i + 1] = col[1];
      px[i + 2] = col[2];
      px[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

interface Props {
  variant?: SkyVariant;
  seed?: number;
  cell?: number; // CSS pixels per art pixel
  speed?: number; // drift per second, in noise units
  landscape?: boolean;
  className?: string;
}

export function SkyArt({ variant = "drought", seed = 1, cell = 4, speed = 0.05, landscape = false, className = "sky" }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const palette = PALETTES[variant];
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let t = seed * 7.3;
    let visible = true;
    let raf = 0;
    let last = 0;
    let w = 0;
    let h = 0;
    const size = () => {
      const r = canvas.getBoundingClientRect();
      w = Math.max(16, Math.ceil(r.width / cell));
      h = Math.max(16, Math.ceil(r.height / cell));
      canvas.width = w;
      canvas.height = h;
      render(ctx, w, h, t, palette, seed, landscape);
    };
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (!visible || document.hidden || now - last < 110) return; // about 9 frames per second is plenty for a slow drift
      const dt = last ? (now - last) / 1000 : 0;
      last = now;
      t += dt * speed;
      render(ctx, w, h, t, palette, seed, landscape);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(canvas);
    const io = new IntersectionObserver(([e]) => (visible = e.isIntersecting), { threshold: 0 });
    io.observe(canvas);
    if (!still) raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
    };
  }, [variant, seed, cell, speed, landscape]);
  return <canvas ref={ref} className={className} aria-hidden />;
}

