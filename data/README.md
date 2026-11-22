# Dryspell data layer

Real daily precipitation for 12 launch locations, 1991-01-01 to 2025-12-31 (12,784 days each), from two independent sources, turned into per-season exceedance tables that the pricing engine reads.

```
pnpm --filter @dryspell/data pull    # download both sources -> generated/daily/<id>.json
pnpm --filter @dryspell/data build   # build generated/exceedance.json
pnpm --filter @dryspell/data test    # unit tests for the statistics
```

Raw API responses are cached in `data/.cache` (not committed); the generated JSON is committed so the site and contracts are reproducible without re-downloading.

## Sources and terms of use

| Source | What we use | Terms |
| --- | --- | --- |
| [Open-Meteo Historical Weather API](https://open-meteo.com/en/docs/historical-weather-api) (ECMWF ERA5 reanalysis, `models=era5`) | `precipitation_sum`, daily, UTC | Free API is for **non-commercial** use, under 10,000 calls/day, 5,000/hour, 600/minute. Data are licensed **CC BY 4.0**: attribution and a link to the licence are required wherever the data are shown. Commercial use needs a paid plan. See the [terms](https://open-meteo.com/en/terms) and [licence](https://open-meteo.com/en/licence). ERA5 itself comes from the Copernicus Climate Change Service. |
| [NASA POWER](https://power.larc.nasa.gov/) daily point API (`PRECTOTCORR`, community `AG`) | bias-corrected precipitation, daily | Free and open, no key. NASA asks users to cite the POWER project, service version and date accessed, and to notify the project when redistributing data. See the [referencing guide](https://power.larc.nasa.gov/docs/referencing/). |

Attribution used by this project: *Weather data by Open-Meteo.com (CC BY 4.0), ERA5 from Copernicus Climate Change Service; data also obtained from the NASA Langley Research Center Prediction Of Worldwide Energy Resources (POWER) Project, accessed 2026-11-21.*

Dryspell is a non-commercial hackathon project, so the Open-Meteo free tier applies. A production product would need Open-Meteo's commercial plan or a different licensed source.

## What the tables mean

A policy covers one **location**, one **season** and one **peril**:

| Peril | Statistic over the season window | Pays when |
| --- | --- | --- |
| drought | total rainfall (mm) | total is **at or below** the trigger |
| flood | maximum rolling 3-day rainfall (mm) | maximum is **at or above** the trigger |

**Settlement value.** Each source computes the statistic independently. Each reading is multiplied by a published calibration factor and the settlement value is the **median** of the two calibrated readings (with two sources, their mean).

**Why calibration exists.** The two sources are structurally different. At Niamey, ERA5 gives about 264 mm/year and NASA POWER about 545 mm/year; at Sylhet it is 4,835 versus 3,403. Averaging them raw would mean nothing. Each factor scales a source to the pooled 1991-2025 mean of the two for that location, season and peril, so neither source is favoured. The factors (`calibration_*_ppm`) are in the table so anyone can recompute the settlement value from the two raw readings.

**Exceedance table.** For each location, season and peril there are up to 15 whole-mm trigger levels with:

- `p_ppm`: fitted probability (parts per million) that the settlement value pays out in a season. Gamma fit for drought totals, Gumbel (L-moments) for 3-day maxima. This is what pricing uses.
- `p_empirical_ppm`: raw historical frequency, no smoothing. With 35 seasons it cannot resolve anything below 2.9%.
- `se_ppm`: bootstrap standard error (500 resamples of the seasons). The pricing engine turns this into a risk margin, so thin evidence costs more.
- `p_era5_ppm`, `p_power_ppm`: the same fit on each source alone.
- `source_split_ppm`: share of seasons where exactly one source would have triggered. This is where disputes would come from.

## Where we do not offer cover

A peril is **offered** only where the two sources' season statistics correlate at 0.40 or more. Below that the oracle would average noise and a buyer could not trust that the payout tracks real rain. Of 28 (location, season, peril) combinations, 16 pass (11 drought, 5 flood); the rest stay in `exceedance.json` with `offered: false` so the risk map can show why.

Kano, Sylhet and Can Tho fail on both perils: ERA5 and NASA POWER do not agree on year-to-year rainfall there (at Sylhet they are negatively correlated). Those places are shown on the risk map as "not offered".

## Honest limits

- About 35 seasons per place: tail probabilities carry real sampling error (see `se_ppm`).
- Stationary climate assumed; no trend or ENSO conditioning.
- Both sources are gridded products tens of kilometres wide. They miss local convective storms, so a farm can suffer while the grid cell does not (basis risk). The backtester shows this explicitly.
- Calibration factors are fixed by the deployer in v1.

## Source disagreement, season by season

`pnpm --filter @dryspell/data run disagree` writes `generated/disagreement.json`: for every location, season, peril and trigger level, in how many of the 35 seasons ERA5 alone and NASA POWER alone (each after calibration) fall on **opposite sides of the trigger**. Pooled over the 16 offered covers, the sources decide a trigger differently in **8.4%** of seasons at a ~3% trigger, **17.9%** at ~10% and **23.8%** at ~25%.

Per cover, of 35 seasons (triggers whose fitted chance is about 3%, 10% and 25%):

| Cover | ~3% | ~10% | ~25% |
| --- | ---: | ---: | ---: |
| Niamey monsoon, drought | 3 | 6 | 9 |
| Niamey monsoon, flood | 2 | 8 | 8 |
| Tamale rains, drought | 3 | 8 | 11 |
| Garissa long rains, drought | 5 | 7 | 11 |
| Garissa short rains, drought | 3 | 3 | 3 |
| Garissa short rains, flood | 2 | 1 | 4 |
| Dodoma rains, drought | 2 | 4 | 6 |
| Dodoma rains, flood | 3 | 9 | 10 |
| Gulu first rains, drought | 4 | 11 | 17 |
| Gulu second rains, drought | 6 | 11 | 10 |
| Jodhpur monsoon, drought | 2 | 5 | 5 |
| Jodhpur monsoon, flood | 3 | 8 | 7 |
| Latur monsoon, drought | 2 | 5 | 11 |
| Khon Kaen rains, drought | 2 | 5 | 9 |
| Khon Kaen rains, flood | 3 | 3 | 8 |
| Iloilo wet season, drought | 2 | 6 | 4 |

The relative spread between the two calibrated readings (|ERA5 − POWER| ÷ their mean) has a median of 23% and a 90th percentile of 68%; 20% of season readings are more than 50% apart.

**The contested rule.** On-chain, a policy does not pay automatically when the two calibrated readings are on opposite sides of its trigger or more than `maxSpreadBps` (50%) of their mean apart. It becomes *contested* and the named resolver decides; if the resolver is silent past the timeout, anyone can refund the premium.

**Why the Garissa 2025 gap is not a bug.** For 1 Oct to 31 Dec 2025 the raw APIs return ERA5 19.2 mm over 92 days (3 days above 1 mm, grid cell −0.5°, 39.75°) and NASA POWER 80.8 mm (17 days above 1 mm, point −0.45°, 39.65°); both in mm per day, UTC, no missing days, identical to the committed files. ERA5 is a reanalysis model that under-produces light rain in this region; POWER's bias-corrected product blends satellite rainfall. The calibration factors for that season (1.48 and 0.75) exist because of exactly this.
