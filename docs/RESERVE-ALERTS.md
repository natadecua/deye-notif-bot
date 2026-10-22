# Preserve the house battery while charging the EV

Reserve-planner status: **proposed behavior, not implemented or deployed**. This refines the reserve/planner requirements following the owner's clarification. The simpler daytime-discharge slice below is implemented separately; full alerts and optional manual charging reports retain their rules.

Latest clarification: the owner chose **Batangas City** and **15 minutes** of discharge tolerance. A simpler opt-in daytime battery-use alert is now implemented in the proposed PR, with an explicit **Asia/Manila** timezone and an editable fixed **06:00–18:00** window suggested in the conversation. This adds no weather dependency and does not implement the reserve planner described below. Personal configuration/production deployment remain manual. The offline setup is `npm run daytime:setup`.

## Owner goal

Allow some house-battery contribution to EV charging when it can be spared, including short daytime cloud dips and finishing a charge at night. Warn early enough to leave energy for ordinary household use until useful solar returns. The useful alarm concerns the remaining household reserve, rather than every occurrence of battery discharge above 300 W.

Reported context for this installation, not defaults for other owners:

- House-battery nameplate capacity: **32 kWh**. This is not a verified usable AC-energy figure.
- Existing inverter/grid fallback: **13% SOC**. The bot must not change this setting.
- A typical morning SOC is approximately **40%**. This is an observation, not yet a chosen morning target or the amount used overnight.
- EV settings: **8 A, 13 A, MAX**, with owner-reported MAX approximately **7 kW**. Settings remain manual and nominal ratings are not measurements.
- Brief battery discharge during clouds is acceptable; some nighttime EV charging is acceptable if the house reserve remains adequate.

Still needed before choosing installation thresholds: usual SOC when useful solar stops on a no-EV night, useful-solar start/end times and installation timezone, desired morning SOC, and an agreed warning margin/daytime drawdown tolerance. A count of running appliances does not establish their overnight energy consumption.

## Two separate decisions

1. **Is the car charging?** Use a current owner confirmation initially. Record the reported profile and expiry. Expiry means unknown. Later, an explicitly supported read-only vehicle/charger source could provide measured status. A house-battery reading or a matching power step never establishes EV charging or its contribution.
2. **Is the household reserve being threatened?** Evaluate accepted fresh battery SOC, sustained discharge and explicitly configured reserve rules. Report the household energy budget as an estimate. Do not assert that the EV caused a measured battery drop.

The notification can say, for example: “House reserve is approaching your limit. You reported EV charging. Consider reducing or pausing it manually.” It must identify manual evidence, source-reading time and any estimated quantities. It does not send a stop/reduce command to equipment.

## Reserve arithmetic

Use an owner-reported or validated historical **no-EV overnight SOC drop**, not the morning remainder, as the initial household-use estimate.

`required SOC now = desired morning SOC + estimated remaining household SOC use + warning margin`

The morning target must be at least the owner's grid-fallback floor. Apply the warning margin once. If the required SOC exceeds 100%, show that the chosen budget cannot be met under those assumptions; never hide this by silently clamping it to 100% or claim the house is protected.

Illustrative calculation only: **if** a no-EV night starts at 100% and ends at 40%, the household drop is 60 percentage points. At sunset, a 13% morning target would require about **73% SOC before adding a warning margin**. A 40% morning target would require 100% before a margin, leaving no estimated battery budget for extra EV charging under that same baseline. These are not configured or recommended thresholds; the actual starting SOC and target remain unconfirmed.

On a 32 kWh nameplate basis, 27 percentage points correspond to roughly **8.64 kWh**. This is an illustrative battery-energy calculation, not guaranteed energy delivered to the car; usable capacity, SOC estimation and conversion losses affect the result. Overnight reserve must account for the household energy still needed, so a 13% fallback alone is not an adequate early EV warning threshold.

## Intended day and night behavior

| Situation | Intended experience |
| --- | --- |
| Daytime, short cloud dip, reserve healthy | Keep quiet; do not warn merely because discharge exceeds 300 W. |
| Daytime, prolonged drawdown or agreed SOC-loss budget exceeded | Warn once during the charging session, with observed SOC loss/duration and the configured reserve. Do not predict that solar will recover without a validated source. |
| Nighttime, current charging report, household reserve approaching its boundary | Advise reducing/pausing manually before consuming the agreed household reserve. Finishing the car is allowed while there is estimated headroom. |
| Car reported stopped | Suppress EV-adjustment advice; preserve any separately enabled household low-reserve alarm. |
| Charging report expired/unknown | Do not assume stopped or charging. Display unknown and request a new report when appropriate; a separately enabled household reserve warning must not rely on EV inference. |
| Stale/missing data | Do not estimate current headroom or issue a new charging recommendation from stale readings. |

The initial runtime slice should use explicitly chosen day/night windows and reserve thresholds, default off. Any time-varying overnight budget requires an agreed remaining-load model or adequate baseline history; uniform overnight use must not be assumed from appliance counts. The bot must not silently select a timezone, reserve threshold, morning target or profile for the owner.

## Acceptance requirements before runtime publication

- Meaningful failing tests before adding reserve behavior, including fresh distinct samples, a minimum observation duration, a tolerated cloud dip, a longer drawdown, window boundaries, active/expired manual reports, missing data and rearm/restart behavior.
- Use elapsed sample time as well as sample count; two different timestamps alone do not prove a chosen duration. Bound long gaps and discard stale/out-of-order evidence.
- Preserve existing full/discharge latches during upgrade. The owner can disable the generic discharge notification independently when enabling reserve advice.
- Keep reserve alerts bounded with explicit queue priority, expiry, retry and recovery rules; avoid repeated reminders during one continuous event. Recalculate the Free-plan KV/CPU budget before adding events or history.
- Reuse the station request and owner-local state. Keep the runtime dependency-free, per-owner credentials and Telegram v1.
- Distinguish local/synthetic checks from actual installation validation. No guarantee that a chosen reserve will last the night or that a message will arrive in time.

Next implementation milestone: agree the missing owner inputs, then add one opt-in reserve-warning journey with tests, setup/status visibility, bounded state and manual production deployment.

## Optional weather context

Provider research checked on **2026-10-22**: [Open-Meteo's terms](https://open-meteo.com/en/terms) explicitly allow the free service for personal home automation; its [official project](https://github.com/open-meteo/open-meteo) states no API key is required. The free public service is for non-commercial use with attribution and request limits (below 10,000/day in the terms); it is not a universal free commercial-use promise. Its [forecast documentation](https://open-meteo.com/en/docs) exposes cloud cover and shortwave solar radiation. Those are weather-model forecasts, not the installation's measured PV output or an EV-charging detector. A city-level location is sufficient for an initial context lookup; precise house coordinates and provider credentials are unnecessary.

Recommended next weather slice: one bounded periodic request, a small owner-local cache with fetched/forecast timestamps, and an optional forecast-context line on measured daytime alerts. Start with an hourly refresh design (about 24 requests/day) and re-budget cache writes/CPU/retries before coding it. Missing/stale weather must never suppress a measured battery-use alert. Add attribution where forecast data is displayed. Do not promise a cloud's clearing time or infer a precise charging window from cloud percentage alone; site-specific PV estimates need confirmed array data and comparison with real production. Weather integration has **not** been implemented or live-tested.

[Forecast.Solar's free public API](https://forecast.solar/index.html) is another option for solar-production forecasts, with today/tomorrow and hourly resolution in the published plan. It requires installation details to make the result useful. Open-Meteo is the simpler initial weather-context option; a full solar/EV planner remains a later, separately validated feature.
