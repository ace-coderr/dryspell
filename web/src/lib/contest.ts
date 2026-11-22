// The source-disagreement rule (PolicyBook._assess): a policy does not pay automatically when the two
// calibrated readings fall on opposite sides of its trigger, or differ by more than maxSpreadBps of their mean.
import type { PerilName, PerilData } from "./data";

export interface Assessment {
  eraX: number; // 0.1 mm units, after calibration
  powX: number;
  spreadBps: number;
  opposite: boolean;
  eraSays: boolean;
  powSays: boolean;
  contested: boolean;
}

/** raw reading in mm -> calibrated reading in 0.1 mm, floored like the contract */
export const calibrate = (rawMm: number, calPpm: number) => Math.floor((Math.round(rawMm * 10) * calPpm) / 1e6);

export function assess(peril: PerilName, trigger: number, eraX: number, powX: number, maxSpreadBps: number): Assessment {
  const t10 = trigger * 10;
  const says = (v: number) => (peril === "drought" ? v <= t10 : v >= t10);
  const eraSays = says(eraX);
  const powSays = says(powX);
  const opposite = eraSays !== powSays;
  const sum = eraX + powX;
  const spreadBps = sum === 0 ? 0 : Math.floor((Math.abs(eraX - powX) * 20000) / sum);
  return { eraX, powX, spreadBps, opposite, eraSays, powSays, contested: opposite || spreadBps > maxSpreadBps };
}

export const calibrateFor = (pd: PerilData, eraMm: number, powMm: number) => ({
  eraX: calibrate(eraMm, pd.calibration_era5_ppm),
  powX: calibrate(powMm, pd.calibration_power_ppm),
});

export const MAX_SPREAD_BPS_DEFAULT = 5000;
