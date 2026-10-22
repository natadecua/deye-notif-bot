# Product requirements: battery notifications and charging advice

Audit date: **2026-10-22**. Runtime audited at commit `3819d75`.

**Current status:** the original notification-only core is implemented and has passed 65 unit/functional tests plus one workerd test and hosted CI. No live Deye/Telegram integration or Cloudflare deployment has been tested. The onboarding and planner described below are an expanded specification, **not implemented functionality**.

## 1. Product goal and boundaries

Help a household decide when to charge its EV, when to reduce or pause charging, and when its house battery reaches full charge. Deliver concise, useful Telegram messages. Installation belongs to the household's own Cloudflare Workers Free account. No central service collects credentials. No additional hardware or always-on home computer is required.

All inverter/charger/car changes remain manual, including setting charging schedules in the car. The bot never changes a charger current, inverter setting or car schedule. Weather and historical estimates are advisory, not a guaranteed optimal schedule or guarantee that the car will reach its target.

Initial example configuration, based on reported capabilities (not global defaults):

- Deepal EV charger, with charging selected through the car.
- Available car settings reported by the owner: **8 A, 13 A, MAX**.
- Owner-reported MAX is approximately **7 kW**, not a verified current or measured power.
- The car supports scheduled charging.
- Selected objective for this example: **use solar first, allowing grid charging if needed before departure**. Other installations choose their own objective.
- Phase configuration, operating voltage, charger minimum/maximum specifications, exact EV/charger model, any read-only telemetry API and household system details remain unconfirmed.

At a **confirmed 230 V single-phase** installation, approximate AC input power is 1.84 kW at 8 A and 2.99 kW at 13 A. At 240 V those estimates are 1.92 and 3.12 kW. These are conditional electrical calculations, not measurements of the owner's installation. The bot must use each installation's actual supported choices rather than generic 3.5/7 kW presets. Never infer MAX amperage from an approximate 7 kW label. Balanced three-phase calculations require explicit confirmation and use all three phases.

## Customization is a core requirement

The product is a generic Deye household notification/advice engine. Deepal is one configuration example, not a required vehicle, exclusive integration or hard-coded policy. A household with no EV must be able to use just the battery alerts.

Each installation owns its settings and selects:

- Station/region, verified measurement interpretation and installation timezone.
- Notification categories, thresholds, rearm levels, confirmation counts, quiet hours, language/time formatting, digest times and advice cooldowns.
- A labelled set of supported charging profiles: discrete amp settings such as 8/13/MAX, other verified current choices, or appropriately bounded power profiles. Range-based chargers require explicit minimum/maximum/step configuration. Unsupported modes must never be suggested.
- Verified phases/voltage, power limits and whether EV status is measured, manually acknowledged or unknown.
- Solar capacity, house-battery reserve/evening goal, household-versus-EV priorities and car availability/departure/energy needs.
- Solar-only, solar-first with departure fallback, or a later tariff-aware objective. Tariff optimization needs real tariff inputs and must not be silently enabled.

Keep connection secrets separate from non-secret preferences, runtime alert state, session state and historical samples. Presets should prefill editable values and require confirmation of electrical constraints. A preference migration must preserve existing installations and alert latches; new planner features default off until their inputs are confirmed. All personalization stays in the installation owner's cloud account, with export/reset/reconfigure behavior that never includes secrets in public files.

## 2. Audit against the original PRD

| Requirement | Implemented evidence | Remaining validation/gap |
| --- | --- | --- |
| Full house battery: default 100%, rearm below 97% | `src/alerts.ts`, transition tests | Actual SOC scale and station data require live confirmation. |
| Sustained discharge >300 W across two distinct fresh readings; rearm below 100 W | `src/alerts.ts`, freshness/monitor tests | Does not identify what appliance caused discharge. |
| Conditional EV wording | Discharge messages say “If the EV is charging…” | Preserve this unless an explicitly identified source establishes EV status. |
| Optional current-reduction calculation | Confirmed voltage/phases/minimum; ceil(W / V) or ceil(W / (3V)) | Current EV amperage is unknown. Current generic estimate does not model the owner's discrete 8/13/MAX choices. |
| Telegram delivery and test command | `src/telegram.ts`, CLI test/discovery commands | No real bot token/chat delivery was tested. |
| Five-minute cloud polling, per-owner account, Secrets and KV | Worker entry point, Wrangler template, ignored secret files | Not deployed; CPU/quota estimates are not production measurements. |
| Token cache/expiry, bounded retries and backoff | REST client and regression tests, including HTTP 408 red/green history | Live regional authorization/schema still untested. |
| Freshness, distinct timestamps, missing values, long gaps, persistence | Reading/state-machine/monitor tests | Distributed KV and Telegram cannot provide exactly-once delivery. |
| Guided setup, station selection, units and preview | `npm run setup`, terminal prompts in `scripts/cli.ts` | Technical laptop wizard, not friendly Telegram onboarding. |
| Configurable full/discharge thresholds, freshness and EV hints | Terminal wizard + ignored local configuration | No independent full/discharge notification switches or in-chat settings. |
| License, contribution guidance, synthetic fixtures, CI and troubleshooting | MIT, CONTRIBUTING.md, AGENTS.md, README.md, tests | Original core is implemented, not a completed live installation. |

Current normalized runtime readings retain only timestamp, house-battery SOC and discharge watts. Raw station preview also shows generation/consumption/charge fields, but the runtime does not retain them for a planner or historical analysis. Optional device discovery exists; an automatic device adapter is not implemented.

## 3. Expanded feature status

| Feature | Current status |
| --- | --- |
| Full-battery and sustained-discharge messages | Implemented, synthetic validation only |
| Notification selection and simple/advanced presets | Not implemented |
| Telegram onboarding/settings buttons | Not implemented |
| Quiet hours, local timezone scheduling and daily recap | Not implemented |
| 8 A / 13 A / MAX charging profiles | Not implemented |
| Manual charging-session acknowledgement and expiry | Not implemented |
| Confirmed automatic EV charging detection | No data source established; not implemented |
| “Good time to start”, “reduce”, “pause” and “resume” recommendations | Not implemented |
| Car-target/house-battery-reserve handling | Not implemented |
| History collection, learned household baseline and solar pattern | Not implemented |
| Weather-adjusted charging windows and departure grid fallback | Not implemented |

## 4. Proposed onboarding experience

Developer credentials and raw API checks stay in the laptop/Cloudflare setup. The Telegram conversation must never request Deye passwords, password hashes, App Secrets, bot tokens or other authentication secrets.

After the owner connects Deye and Telegram, the bot introduces itself:

> I help you use solar for your car while watching your house battery. I send advice; you make the changes in the car. Let's choose the updates you want.

### Step A: choose notifications

Buttons toggle each category independently. Offer a “Recommended” preset and “Customize”.

| Notification | Recommended preset | Customization |
| --- | --- | --- |
| House battery full | On | SOC trigger, default 100%; rearm, default <97% |
| House battery supplying power | On | Default >300 W, two distinct fresh readings; rearm <100 W |
| Good time to start/restart EV charging | Optional, requires planner setup | Allowed days/time window, stable headroom, minimum duration |
| Reduce or pause EV charging | Optional, requires session/profile setup | Permitted battery discharge, house-battery reserve and grid-import preferences |
| Morning charging plan | Optional | Local delivery time and car availability |
| End-of-window/target reminder | Optional | Manual session or verified EV target, departure deadline |
| Daily recap | Optional | Local delivery time; only report observed/labelled estimated quantities |

In simple mode, show friendly descriptions and recommended values. Put thresholds, margins, hysteresis and confirmation counts under “Advanced”. Toggling a delivery preference must not accidentally reset an alert cycle or flood old messages.

### Step B: confirm the charging choices

Show the owner's available settings: 8 A, 13 A, MAX. Confirm electrical phases, line-to-neutral voltage and the documented supported minimum. Obtain MAX's verified power limit for planning if available, while preserving its label and never inventing current amperage.

Without charger/EV telemetry, the bot can offer status buttons:

- **I set 8 A**
- **I set 13 A**
- **I selected MAX**
- **I stopped charging**

These buttons **record what the user did**; they do not control the vehicle. Distinguish planned sessions from user-confirmed charging. A scheduled time alone does not establish that the car is plugged in or drawing power. Manual session status expires at an agreed deadline/end time; expiration means “status unknown”, not “charging stopped”.

### Step C: choose the objective and constraints

Default for this owner: **solar first, grid allowed before departure**.

Collect car-available days/windows (e.g. 09:00–16:00), next departure time and the requested energy to add. If actual EV SOC/capacity is unavailable, allow a user-entered energy goal rather than fabricating a car SOC. Clearly distinguish energy drawn at the charger from energy stored in the car; losses and reduced actual charging rates affect completion estimates.

Collect the house-battery reserve, desired house-battery SOC by evening, and whether house battery or EV receives priority while solar is limited. A low reserve is a boundary, not a daily target. No user-specific reserve or evening target has been chosen yet.

### Step D: location and system

Confirm the **installation's** location and IANA timezone, not the chat/laptop timezone. If all devices are in Singapore, use Asia/Singapore; do not assume that location from the conversation.

For weather/planning, collect array kWp, inverter AC limit, usable house-battery capacity and any known panel orientation/tilt. Deye station metadata can prefill supported fields but requires owner confirmation. Unknown values should reduce functionality/confidence rather than trigger guessed precise forecasts.

### Step E: delivery preferences and test

Select quiet hours, digest/plan times and a cap on repetitive advisory messages. Preview the exact enabled rules in friendly language, then send a test message. Always provide a settings summary and a way to pause recommendations. House-battery emergency bypass behavior must be explicitly configured; these routine messages should respect quiet hours by default.

## 5. What “detect charging” can honestly mean

Deye's total house/inverter load cannot uniquely identify a 3.5 kW, 7 kW or Deepal charging load. Air conditioning, appliances and combinations of loads can look similar. House-battery SOC is not the car's SOC.

Supported source tiers for a future implementation:

1. **Measured:** an authorized read-only EV/charger API or existing dedicated charger meter provides charging status and power with fresh, aligned timestamps. Verify the exact model/API, permissions and cost before adding an adapter. Do not assume Deepal offers a free, supported API.
2. **User confirmed:** the owner records 8 A/13 A/MAX. Actual power remains unknown; display a nominal estimate and the time of confirmation.
3. **Load pattern:** at most an explicitly labelled optional “possible extra load” observation. Never say “car charging detected” or train a reliable EV power trace from a load step alone. It is not required for the recommended v2.

No additional meter/hardware is required for the manual mode. If no free supported telemetry source exists, the product remains usable through manual acknowledgement.

## 6. Proposed live recommendation rules

These are acceptance requirements to implement, not active runtime behavior.

### Start or resume

Recommend a supported profile only when fresh, validated data supports enough headroom for that profile plus the configured margin and the household/battery constraints. Require sustained evidence rather than one sunny reading. A full house battery alone is not evidence of spare solar.

Approximate planning budget:

```
EV budget = predicted solar generation
          - predicted non-EV house demand
          - power reserved for house-battery recovery
          - uncertainty margin
```

Validate measurement scope before computing a live equivalent. `consumptionPower` may already include the EV; subtracting the EV again would double-count it. Non-EV house load requires aligned measured charger power or an appropriately learned baseline. With manual-only status, do not present the profile estimate as a measured separation of house and EV consumption. Missing measurements must not become zero.

Choose from 8 A, 13 A and MAX, subject to verified electrical setup. Never recommend an unsupported intermediate setting or below the documented minimum. For a confirmed 230 V single-phase setup, a 3.1 kW conservative budget can support the 13 A nominal profile; it cannot support a nominal 7 kW MAX solely from solar.

### Reduce or pause

When an acknowledged charging session coincides with sustained house-battery discharge above the configured allowance, recommend a lower supported profile **if fresh evidence supports it**. Otherwise suggest a manual pause, unless the configured departure/grid policy justifies grid-assisted charging.

Separate alert causes: house battery supplying power, grid import increasing, battery reserve reached, and charging window ending. A falling house battery at night must not become an unconditional “stop the car” instruction when EV status is unknown. Preserve “If the EV is charging…” in that case.

A reserve condition can be checked with one fresh validated reading rather than waiting through another discharge-confirmation cycle; the chosen product rule must be explicit and tested. It is still a cloud notification with cloud latency, not an equipment protection mechanism.

### Deadline and target

Before departure, estimate whether the remaining available time can deliver the requested energy at the permitted rates. If solar alone looks insufficient and grid fallback is allowed, send an early grid-assisted charging recommendation with its reason. Never claim the grid-only maximum is safe for the installation without verified user constraints, or that the target is guaranteed.

Only report an EV SOC target reached with verified EV SOC. Only report delivered energy with sufficiently complete measured charging data. Manual-profile time integration can be shown as an **estimate**, excluding unknown intervals; it is not proof that the car is full. An end-of-window reminder is possible without knowing car SOC.

### Quiet hours and repeated advice

Deduplicate state transitions and use hysteresis. Do not send a different profile suggestion every five minutes during passing clouds. Coalesce material plan changes, apply configurable cooldowns, and revalidate before delivering delayed advice. An expired or obsolete recommendation must not arrive after conditions have changed. Changes to notification preferences must not rearm unrelated battery cycles.

## 7. Better than a fixed 09:00–16:00 schedule

Use 09:00–16:00, if entered by the owner, as the **availability envelope**. A recommended window inside it should depend on expected solar surplus, energy needed, supported charging settings, house-battery needs and departure time. It can move between days and seasons. No specific daily window can be recommended yet because installation data and an energy/departure goal are missing.

Development sequence:

1. **Live advice:** use validated present readings and explicit session/profile status. Useful immediately, with no claim of future optimality.
2. **Pattern estimate:** store distinct valid samples and learn the household's daylight production and non-EV load by local time/day type. Exclude gaps and uncertain EV periods. Start provisional and report limited history; collect roughly two weeks of usable observations before treating a pattern as representative, and evaluate forecast errors rather than assuming accuracy.
3. **Weather adjustment:** combine predicted irradiance with the site's orientation/capacity and its measured production pattern. Cloud-cover percentage alone is not a kW prediction. Curtailed/clipped production, shading, seasonal changes and missing data must not silently become a guaranteed future production ceiling.
4. **Rolling plan:** rank feasible blocks by solar coverage, while respecting battery/energy/departure constraints. Recommend understandable blocks (e.g. half-hour steps), explain assumptions/confidence and revise materially when forecast or measured conditions change. Do not imply minute-level precision from hourly forecasts.
5. **Fallback:** unavailable/stale weather falls back to a clearly labelled pattern estimate; insufficient history falls back to current-condition advice or the user's manual schedule. Never fabricate a future optimal window when the inputs are missing.

Solar-first aims to reduce grid import while meeting the departure goal. The cheapest financial schedule is a different objective and needs import tariffs/export credits; no cost-saving amount should be promised without those inputs. Car scheduling remains manual.

## 8. Architecture and zero-cost constraints

Keep the current battery monitor working independently of optional planning. The 10 ms Workers Free Cron CPU budget still applies; profile and benchmark every added path before claiming Free-plan viability. Adding features must not silently require an upgrade or always-on host.

A proposed architecture is KV for small operational state/authentication and optional D1 for bounded history, preferences/session audit and indexed aggregates. D1 is not currently configured. At five-minute sampling, one installation produces at most 288 distinct samples/day or 8,640/30 days. Actual row writes also include indexes, aggregates and retention deletes; index queries and cap retention/backfill. Current D1 Free docs list 5 million rows read/day, 100,000 rows written/day, 500 MB per database and 5 GB total. These figures establish an available design option, not a measured planner budget. Re-estimate total KV traffic too: the current 864-write/day worst-case estimate leaves little room for careless per-poll additions or menu traffic.

Weather is optional. Open-Meteo currently offers a free **non-commercial** API with attribution and rate limits; its public service is not a universal free commercial-use promise. A household installation may use that eligible tier, but commercial deployments need a separately compliant provider/configuration. Cache a small forecast and fetch it only periodically; do not poll weather every five minutes or add paid API subscriptions. The no-weather mode must remain usable.

Telegram onboarding requires a new authenticated inbound webhook, separate from the current all-404 HTTP handler. Validate Telegram's webhook secret, restrict setting changes to explicitly allowed owner identities/chats, handle repeated/out-of-order updates, cap request/DB work and never log secret-bearing URLs. A shared notification group is not automatic authorization for every member to change settings. Changing the webhook/public route is a deliberate, tested feature, not part of the deployed v1 today.

## 9. TDD acceptance work, in order

Write and observe the failure of each behavior test before implementing it. These are proposed acceptance cases, not passing tests already present in the repository.

**Milestone 1: notification preferences and onboarding**

- Each rule can be enabled/disabled independently; disabled delivery does not produce a message or reset other cycles.
- Default settings preserve the original full/discharge rules.
- A known phase/voltage produces nominal profile estimates; unknown phases/voltage block power/current advice.
- User-confirmed choices are limited to supported 8 A/13 A/MAX, and MAX current is never inferred.
- Unauthorized/replayed Telegram updates cannot change preferences; repeated deliveries do not create repeated effects.
- Quiet-hour/day boundaries, including overnight windows and daylight-saving changes, use the installation timezone.
- A manual session expires to unknown status, not to a fabricated “stopped” state.

**Milestone 2: live start/reduce/pause advice**

- A confirmed 230 V single-phase 13 A profile estimates 2,990 W; 8 A estimates 1,840 W.
- A conservative 3,100 W available budget can select 13 A, not a nominal 7,000 W MAX; a 1,300 W budget supports neither 8 A nor 13 A.
- A full battery with insufficient solar never generates “good time to start”.
- House/EV demand is not double-counted; unknown/incomplete measurements suppress precise recommendations.
- Sustained discharge while a session is acknowledged produces a supported lower-profile/pause recommendation, subject to the configured grid/departure objective.
- Minimum current, house-battery reserve, missing data, stale telemetry, cloud transients, cooldowns and recovery are tested.
- No-session messages remain conditional; no inferred 7 kW appliance is called a detected EV.

**Milestone 3: history and daily planning**

- Historical duplicate timestamps are not stored twice; gaps are not counted as continuous energy.
- Known/uncertain EV sessions are not silently folded into a non-EV baseline.
- Forecasts cannot create energy outside daylight/availability, exceed verified AC limits, or consume a protected house-battery budget.
- Solar-first plans allow grid fallback only under the owner's selected policy and explain an infeasible energy/departure request.
- Weather failure, insufficient history, manual schedule conflicts, local-date/DST transitions and incomplete charging-energy evidence have explicit fallbacks.
- Tests distinguish nominal AC energy from actual EV-battery energy, and estimated completion from measured target attainment.
- Replay a labelled synthetic sunny day, passing-cloud day, heavy-house-load day and missing-data day before any real installation trial. Compare forecasted versus actual outcomes during later live validation.

## 10. Information still needed for a personalized plan

Confirm electrical phases and voltage; exact EV/charger model and any existing free supported read-only API; solar installation location/timezone, array kWp and inverter AC limit; usable house-battery capacity, desired reserve/evening target and charging priority; the EV's availability window, energy to add and departure deadline. These are onboarding inputs, not assumptions to hide behind defaults.

No generic 09:00–16:00 window is called optimal without these inputs and validation. The next implementation milestone is the notification/profile/session onboarding and live advice, followed by optional history/weather planning.

See [the proposed seamless setup flow](ONBOARDING.md) for Cloudflare provisioning and Telegram pairing.

## Sources reviewed for the expanded design

- [Existing implementation](../src/alerts.ts), [current configuration](../wrangler.example.jsonc), [setup wizard](../scripts/cli.ts), [validation record](VALIDATION.md), and [verified Deye API boundaries](DEYE-API.md).
- [Open-Meteo forecast documentation](https://open-meteo.com/en/docs): irradiance fields and orientation parameters; not a turnkey site-specific PV forecast.
- [Open-Meteo pricing/usage terms](https://open-meteo.com/en/pricing): non-commercial free-service eligibility, limits and attribution.
- [Cloudflare D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [limits](https://developers.cloudflare.com/d1/platform/limits/): available Free-plan resources; no deployment/usage measurements were performed.
