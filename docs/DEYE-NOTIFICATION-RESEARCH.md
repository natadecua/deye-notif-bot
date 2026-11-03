# Deye API opportunities for notifications

Historical draft recovered from the original checkout on 2026-11-03. The dated research/proposals below describe 2026-10-22, not current support or new live validation. Current implementation and verification gates take precedence: [improvement loop](IMPROVEMENT-LOOP.md), [grid import](GRID-IMPORT.md), [measured context](MEASURED-CONTEXT.md), [reserve policy](RESERVE-ALERTS.md), [Telegram commands](TELEGRAM-BOT.md) and [validation](VALIDATION.md). Readable local/kW status, authorized commands and default-off health/recap/quiet/grid preparation have since progressed; grid remains inactive pending installation evidence.

Reviewed **2026-10-22** against Deye's public documentation and regional REST schema. This is documentation research, not an authenticated inspection of this installation. None of the proposed notifications below has been implemented or deployed.

## Best next addition: context inside existing alerts

The existing `/station/latest` request declares additional fields that could explain the situation when a full/discharge alert fires. Adding validated optional context would not require another upstream request or a separate event.

| Detail | Published field | Notification value | Validation required |
| --- | --- | --- | --- |
| Solar generation | `generationPower` | Is solar producing strongly when the battery becomes full? | Actual availability, units, freshness and installation meaning |
| House consumption | `consumptionPower` | How much demand accompanies battery discharge? | Units and which loads/meters are included; never identify EV consumption from this aggregate |
| Battery charging power | `chargePower` | Distinguish measured charging from the existing discharge measurement | Units/direction; a single value does not prove a sustained charging state |
| Grid import/export context | `purchasePower`, `gridPower` | Is the house also buying power, or exporting? | Meter support and each field's actual sign/direction; the schema does not define these sufficiently |
| Reading age | `lastUpdateTime` plus send time | Make cloud delay concrete | Calculate at each delivery attempt; use the existing strict timestamp interpretation |

Do not label `wirePower` as export or `irradiateIntensity` as a universal irradiance measurement without additional evidence. Their names alone do not establish a useful, correctly scaled reading. Do not assume the unit confirmed for `dischargePower` also proves every optional field's unit.

Example of a proposed enriched message, with **synthetic values only**, after units and field meanings have been confirmed:

```text
🔋 House battery full

Charge: 100%
Solar: 4.2 kW
Home demand: 1.3 kW

Reading: 22 Oct 2026, 08:24:07 UTC
Deye Cloud data may be delayed.
```

Missing optional values should be omitted, never converted to zero. An unavailable optional field must not disable the existing valid SOC/discharge alert. Reuse the fresh reading used for delivery, including retries. Keep optional context small and bounded in the existing state checkpoint; no additional per-poll KV operation is necessary for this design, but payload/CPU costs need measurement.

## Other useful notifications

These are proposed product rules, not built-in Deye push subscriptions.

| Priority | Proposed notification | Data source | Design considerations |
| --- | --- | --- | --- |
| High | Battery reserve low / reserve recovered | Existing `batterySOC` | Owner-selected reserve, distinct fresh samples, hysteresis and one bounded notice per cycle; no additional Deye endpoint |
| High | New Deye warning/failure / alert cleared | `/station/alertList` or `/device/alertList` | Alert ID, code/name, level and open/closed status support lifecycle tracking. Use bounded overlapping windows, pagination, capped deduplication and capped retries; never infer closure from disappearance alone |
| High | Cloud telemetry stale / fresh again | Existing reading validation; optionally `/device/latest` | State this as data availability. Device state distinguishes online, alert and offline; neither an offline device nor zero grid import proves a grid outage |
| Medium | Sustained grid import above an owner limit | Validated station grid/import fields | Additional trigger can reuse the station response; confirm direction, exclude missing data and use hysteresis/confirmation |
| Medium | Battery full with sustained export | Validated SOC and export measurement | Describe observed export. It is not a guarantee that surplus will persist or that a particular EV setting is appropriate; avoid generation-minus-load arithmetic that double-counts charging loads |
| Medium | Daily energy recap | `/station/history` | Published history fields include generation, consumption, purchase and battery charge/discharge totals. Confirm energy units, station-local day boundaries, completeness and end-date semantics before presenting kWh |
| Later | Temperature, battery health or electrical diagnostics | `/device/measurePoints` followed by `/device/latest` | Discover actual device point names first. Temperature/SOH/voltage/frequency availability is model-specific and not guaranteed by the generic schema. Use documented equipment limits, not invented universal thresholds |

For alert forwarding, preserve Deye's classification as a reported classification, not a diagnosis. Station/device alert levels are documented as notice, warning and failure; status is open or closed. Device alerts additionally declare description/reason/solution fields. Prefer a short name/code/severity and source time; do not automatically turn vendor solution text into equipment-control instructions. Do not expose serial numbers or account details in notifications by default.

Daily energy totals are preferable to integrating occasional power samples across unknown gaps. Avoid savings/currency claims without a separately verified tariff. A “time until empty/full” estimate needs confirmed usable capacity, reserve, efficiency and representative sustained power; SOC alone is insufficient, so this should not be an initial feature.

## Cost, adapter and testing boundaries

- Keep the five-minute cadence. Enrich existing event messages first. Deye's published best-practices page says plant summaries are cached/refreshed at most every five minutes and warns of evolving metering/quota/rate controls. No new feature should depend on a paid API plan.
- Station/device alert/history endpoints are **not** in the runtime's current read-only allowlist. Adding them requires a deliberate tested adapter extension. Device latest/measurement-point discovery are already allowed, but no automatic model-specific mapping exists.
- At five-minute polling, one additional endpoint on every run adds **288 requests/day**, before retries, authentication or pagination. Prefer a bounded slower schedule where suitable; model those costs before enabling it.
- The current outbox supports at most two pending battery events. New alert categories cannot simply be appended: define a bounded queue, retention, priority, expiry and KV budget first. Reuse state checkpoints and preserve existing full/discharge latches. KV consistency still permits duplicate/lost deliveries.
- Write tests before runtime changes: optional missing/null/invalid enrichment, per-field units/directions, fresh retry context, low-reserve boundaries, duplicate readings, fault open/closed transitions, repeated IDs/pages, capped backlog/retries, day/DST boundaries, and unavailable optional endpoints. Verify the selected adapter in local workerd, then record installation-specific live findings separately.
- No inverter/charger commands, extra credential service, raw response logging or secret-bearing request URLs are needed for any proposal.

Suggested implementation order: **optional solar/home/charging context and reading age**, then **low-reserve alerts**, then **Deye fault lifecycle forwarding**. Validate actual field availability privately with the owner's existing setup/preview workflow before enabling each addition. Fault forwarding has high value but needs more state and request-budget work than contextual display.

## Primary sources

- [Deye regional REST schema](https://eu1-developer.deyecloud.com/v2/api-docs): inspected response definitions for station latest/list/device/alerts/history and device latest/alerts/measurement points. The public schema still contains the malformed example `[12583SS]`; research parsing quoted only that example locally, as in the previous API review. No live response was repaired or interpreted this way.
- [Deye tool documentation](https://developer.deyecloud.com/openmcp/docs/deye-open-mcp-tools.html): corroborates endpoint response fields. This project continues to call REST directly; it does not submit owner credentials to an MCP service.
- [Deye API best practices](https://developer.deyecloud.com/best-practices): current public SPA text was inspected through its public JavaScript asset because the page is client-rendered. Metering figures there are preliminary and do not establish this account's entitlement.
- Existing [adapter boundaries](DEYE-API.md), [architecture and delivery limitations](ARCHITECTURE.md), and [notification UX ideas](NOTIFICATION-UX.md).
