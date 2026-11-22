import { useEffect, useRef, useState } from "react";

/** animates a number toward its latest value (ease-out); jumps straight there for reduced motion */
export function useTween(target: number | undefined, ms = 520): number | undefined {
  const [value, setValue] = useState<number | undefined>(target);
  const from = useRef<number | undefined>(target);
  const raf = useRef(0);
  useEffect(() => {
    if (target === undefined) {
      setValue(undefined);
      from.current = undefined;
      return;
    }
    const start = from.current ?? target;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || start === target) {
      setValue(target);
      from.current = target;
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - k, 3);
      const v = start + (target - start) * eased;
      setValue(v);
      from.current = v;
      if (k < 1) raf.current = requestAnimationFrame(step);
    };
    raf.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf.current);
  }, [target, ms]);
  return value;
}
