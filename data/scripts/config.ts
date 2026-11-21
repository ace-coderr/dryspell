// Launch locations and the rainy seasons Dryspell covers.
// Seasons are chosen from published regional climatology (main rainy
// season(s) of each place). The build script prints the resulting mean
// season totals so a wrong window is easy to spot.

export interface SeasonDef {
  id: string; // e.g. "jjas"
  name: string; // human label
  start: string; // MM-DD, inclusive
  end: string; // MM-DD, inclusive; if before `start` the season crosses new year
}

export interface LocationDef {
  id: string;
  name: string;
  country: string;
  region: "West Africa" | "East Africa" | "South Asia" | "Southeast Asia";
  lat: number;
  lon: number;
  note: string; // why weather cover matters here
  seasons: SeasonDef[];
}

export const PERIOD = { startYear: 1991, endYear: 2025 } as const;

export const LOCATIONS: LocationDef[] = [
  {
    id: "kano",
    name: "Kano",
    country: "Nigeria",
    region: "West Africa",
    lat: 12.0,
    lon: 8.52,
    note: "Sahel-edge cereal belt; a single monsoon season decides the harvest.",
    seasons: [{ id: "jjas", name: "Monsoon (Jun–Sep)", start: "06-01", end: "09-30" }],
  },
  {
    id: "niamey",
    name: "Niamey",
    country: "Niger",
    region: "West Africa",
    lat: 13.51,
    lon: 2.11,
    note: "Rain-fed millet and sorghum; frequent drought years and river floods.",
    seasons: [{ id: "jjas", name: "Monsoon (Jun–Sep)", start: "06-01", end: "09-30" }],
  },
  {
    id: "tamale",
    name: "Tamale",
    country: "Ghana",
    region: "West Africa",
    lat: 9.4,
    lon: -0.84,
    note: "Northern Ghana maize, yam and groundnut farming on one rainy season.",
    seasons: [{ id: "mjjas", name: "Rains (May–Sep)", start: "05-01", end: "09-30" }],
  },
  {
    id: "garissa",
    name: "Garissa",
    country: "Kenya",
    region: "East Africa",
    lat: -0.45,
    lon: 39.65,
    note: "Arid and semi-arid pastoral land; two short rainy seasons, recurrent drought.",
    seasons: [
      { id: "long", name: "Long rains (Mar–May)", start: "03-01", end: "05-31" },
      { id: "short", name: "Short rains (Oct–Dec)", start: "10-01", end: "12-31" },
    ],
  },
  {
    id: "dodoma",
    name: "Dodoma",
    country: "Tanzania",
    region: "East Africa",
    lat: -6.17,
    lon: 35.74,
    note: "Central Tanzania maize and sunflower; one long season that crosses new year.",
    seasons: [{ id: "ndjfma", name: "Rains (Nov–Apr)", start: "11-01", end: "04-30" }],
  },
  {
    id: "gulu",
    name: "Gulu",
    country: "Uganda",
    region: "East Africa",
    lat: 2.77,
    lon: 32.3,
    note: "Northern Uganda smallholders; two cropping seasons a year.",
    seasons: [
      { id: "first", name: "First rains (Mar–May)", start: "03-01", end: "05-31" },
      { id: "second", name: "Second rains (Aug–Nov)", start: "08-01", end: "11-30" },
    ],
  },
  {
    id: "jodhpur",
    name: "Jodhpur",
    country: "India",
    region: "South Asia",
    lat: 26.24,
    lon: 73.02,
    note: "Thar-desert margin; monsoon failure is the central farm risk.",
    seasons: [{ id: "jjas", name: "Monsoon (Jun–Sep)", start: "06-01", end: "09-30" }],
  },
  {
    id: "latur",
    name: "Latur",
    country: "India",
    region: "South Asia",
    lat: 18.4,
    lon: 76.58,
    note: "Marathwada kharif farming; repeated drought years.",
    seasons: [{ id: "jjas", name: "Monsoon (Jun–Sep)", start: "06-01", end: "09-30" }],
  },
  {
    id: "sylhet",
    name: "Sylhet",
    country: "Bangladesh",
    region: "South Asia",
    lat: 24.9,
    lon: 91.87,
    note: "Among the wettest lowlands on Earth; flash floods wipe out the boro and aman crops.",
    seasons: [{ id: "mjjas", name: "Monsoon (May–Sep)", start: "05-01", end: "09-30" }],
  },
  {
    id: "khonkaen",
    name: "Khon Kaen",
    country: "Thailand",
    region: "Southeast Asia",
    lat: 16.44,
    lon: 102.83,
    note: "Isan rain-fed rice and cassava; both dry spells and floods hit yields.",
    seasons: [{ id: "mjjaso", name: "Rains (May–Oct)", start: "05-01", end: "10-31" }],
  },
  {
    id: "cantho",
    name: "Can Tho",
    country: "Vietnam",
    region: "Southeast Asia",
    lat: 10.03,
    lon: 105.78,
    note: "Mekong Delta rice basket; wet-season storms and flooding.",
    seasons: [{ id: "mjjason", name: "Wet season (May–Nov)", start: "05-01", end: "11-30" }],
  },
  {
    id: "iloilo",
    name: "Iloilo",
    country: "Philippines",
    region: "Southeast Asia",
    lat: 10.7,
    lon: 122.56,
    note: "Western Visayas rice and sugar; typhoon-season rainfall extremes.",
    seasons: [{ id: "jjason", name: "Wet season (Jun–Nov)", start: "06-01", end: "11-30" }],
  },
];

export const SOURCES = {
  era5: {
    id: "era5",
    name: "Open-Meteo Historical Weather (ECMWF ERA5)",
    url: "https://open-meteo.com/en/docs/historical-weather-api",
    licence: "CC BY 4.0",
    licenceUrl: "https://open-meteo.com/en/licence",
  },
  power: {
    id: "power",
    name: "NASA POWER (MERRA-2 / GPM IMERG, PRECTOTCORR)",
    url: "https://power.larc.nasa.gov/",
    licence: "Free and open; cite NASA POWER with version and access date",
    licenceUrl: "https://power.larc.nasa.gov/docs/referencing/",
  },
} as const;
