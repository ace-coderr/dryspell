import raw from "../../../data/generated/exceedance.json";

export type PerilName = "drought" | "flood";

export interface TableRow {
  level_mm: number;
  p_ppm: number;
  p_era5_ppm: number;
  p_power_ppm: number;
  p_empirical_ppm: number;
  se_ppm: number;
  source_split_ppm: number;
}

export interface HistoryRow {
  year: number;
  total_era5_mm: number;
  total_power_mm: number;
  max3_era5_mm: number;
  max3_power_mm: number;
  total_settle_mm: number;
  max3_settle_mm: number;
}

export interface PerilData {
  peril: PerilName;
  distribution: string;
  settlement_mean_mm: number;
  settlement_stdev_mm: number;
  source_correlation: number;
  source_mean_bias_mm: number;
  calibration_era5_ppm: number;
  calibration_power_ppm: number;
  agreement: "high" | "medium" | "low";
  offered: boolean;
  table: TableRow[];
}

export interface Season {
  id: string;
  name: string;
  start: string;
  end: string;
  crosses_new_year: boolean;
  years: number;
  history: HistoryRow[];
  perils: PerilData[];
  locIndex: number;
  seasonIndex: number;
  locSeasonId: number;
  location: Location;
}

export interface Location {
  id: string;
  name: string;
  country: string;
  region: string;
  regionId: number;
  lat: number;
  lon: number;
  note: string;
  seasons: Season[];
}

const REGION_ID: Record<string, number> = { "West Africa": 0, "East Africa": 1, "South Asia": 2, "Southeast Asia": 3 };

// locSeasonId = locationIndex * 10 + seasonIndex ; tableId = locSeasonId * 2 + peril
export const locations: Location[] = (raw as any).locations.map((l: any, li: number) => {
  const loc: Location = { ...l, regionId: REGION_ID[l.region], seasons: [] };
  loc.seasons = l.seasons.map((s: any, si: number) => ({ ...s, locIndex: li, seasonIndex: si, locSeasonId: li * 10 + si, location: loc }));
  return loc;
});

export const allSeasons: Season[] = locations.flatMap((l) => l.seasons);
export const meta = (raw as any).meta;

export const perilIndex = (p: PerilName) => (p === "drought" ? 0 : 1);
export const tableId = (s: Season, p: PerilName) => s.locSeasonId * 2 + perilIndex(p);
export const roundId = (s: Season, year: number) => (BigInt(s.locSeasonId) << 16n) | BigInt(year);
export const perilOf = (s: Season, p: PerilName) => s.perils[perilIndex(p)];
export const seasonByLocSeasonId = (id: number) => allSeasons.find((s) => s.locSeasonId === id);
export const offeredSeasons = allSeasons.filter((s) => s.perils.some((p) => p.offered));

export const regions = ["West Africa", "East Africa", "South Asia", "Southeast Asia"];
