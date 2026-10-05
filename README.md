# Magnetic Storms → Google Calendar

Google Apps Script that automatically adds geomagnetic storms to Google Calendar. Free, no API keys.

## Features

- 3-day storm forecast plus storms already in progress
- One-command backfill of all storms in 2026
- Event color and title depend on storm level G1–G5
- Times shown in the Europe/Moscow time zone (Rostov-on-Don)
- Re-running never creates duplicates
- Auto-run via trigger every 3 hours

## Data sources

| Source | Provides |
|---|---|
| [NOAA SWPC](https://www.swpc.noaa.gov/) `noaa-planetary-k-index-forecast.json` | 3-day Kp forecast |
| NOAA SWPC `noaa-planetary-k-index.json` | observed Kp |
| NOAA SWPC `noaa-scales.json` | daily G-scale estimate (UTC) |
| [GFZ Potsdam](https://kp.gfz.de/) | Kp archive for `backfill2026()` |

## Setup

1. Open [script.google.com](https://script.google.com) → **New project** → paste the code from `magnetic_storms.gs`.
2. **Project Settings** → time zone **(GMT+03:00) Moscow**.
3. Run `main()` and grant Calendar access.
4. Run `createDailyTrigger()` once to schedule auto-runs every 3 hours.
5. Optional: run `backfill2026()` once to load storms since January 1, 2026.

## Functions

| Function | Purpose |
|---|---|
| `main()` | forecast + observed data + daily estimates |
| `backfill2026()` | one-time load of 2026 history |
| `createDailyTrigger()` | creates the trigger (every 3 hours) |

## Configuration (`CONFIG`)

| Parameter | Default | Description |
|---|---|---|
| `TIMEZONE` | `Europe/Moscow` | time zone |
| `CALENDAR_NAME` | `Магнитные бури` | calendar name; empty = default calendar |
| `MIN_KP` | `4.67` | Kp threshold; `4.67` = G1, `5.67` = G2 |
| `INCLUDE_TODAY` | `true` | include intervals since the start of today |
| `MIN_G` | `1` | minimum G level for daily-estimate events |
| `INCLUDE_YESTERDAY` | `true` | add yesterday's storm from `noaa-scales.json` |

## Levels and colors

| Level | Kp | Color | Icon |
|---|---|---|---|
| G1 minor | 5 | Banana | 🟡 |
| G2 moderate | 6 | Tangerine | 🟠 |
| G3 strong | 7 | Flamingo | 🔴 |
| G4 severe | 8, 9− | Tomato | 🟥 |
| G5 extreme | 9 | Tomato | 🚨 |

Google Calendar offers only 11 fixed event colors, so G4 and G5 share one color. Customize in the `LEVELS` constant.

## Limitations

- NOAA and GFZ times are UTC; the calendar displays them in your time zone.
- Daily G estimates cover UTC days (03:00–03:00 Moscow time).
- Recent GFZ data is preliminary and may change slightly.
- Apps Script has a 6-minute execution limit; `backfill2026()` is safe to re-run.
- NOAA's forecast doesn't always predict storms; some arrive unannounced.

## Data licenses

- NOAA SWPC: open US government data.
- GFZ Potsdam: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Please cite: Matzka et al. (2021), *Space Weather*, 19, e2020SW002641.
