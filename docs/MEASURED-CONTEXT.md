# Optional solar, home and grid context: evidence gate

Reviewed **2026-10-26**. **Decision: keep these measurements unavailable in notifications/status.** The public contract confirms candidate field names, but does not establish their units, direction, metering scope or individual freshness. This is a documentation-only readiness assessment, not an adapter, captured installation fixture or live measurement validation.

## Public evidence

The current [EU](https://eu1-developer.deyecloud.com/v2/api-docs), [Americas](https://us1-developer.deyecloud.com/v2/api-docs) and [India](https://india-developer.deyecloud.com/v2/api-docs) Swagger schemas all give the following station fields the same property definitions. Inspection was limited to the read-only station/device schemas. A research-only in-memory repair quoted the previously documented malformed example array before parsing; no runtime parser was changed. Whole public documents were not committed.

| Candidate field | Published shape | Missing evidence / decision |
| --- | --- | --- |
| `generationPower` | Optional number/double | W versus kW, AC/DC boundary, aggregation and source age unknown; do not label it verified available solar. |
| `consumptionPower` | Optional number/double | Units, whole-home versus backup-load coverage, measured versus calculated origin and EV inclusion unknown; do not label it house-only consumption. |
| `gridPower` | Optional number/double | Units and import/export sign unknown; do not announce importing, exporting or a grid outage. |
| `purchasePower` | Optional number/double | Its name does not establish instantaneous import, units, zero meaning or coverage; leave unavailable. |
| `wirePower` | Optional number/double | Physical meaning, direction and units unspecified; do not substitute it for export. |
| `chargePower`, `batteryPower` | Optional number/double | No verified unit/sign relationship to discharge; no absolute-value or net-power fallback. |
| `lastUpdateTime` | Optional string/date-time | No universal UTC/offset convention or per-field collection-time guarantee; retain the existing explicitly configured timestamp adapter. |

Only envelope `requestId` and `success` are required in that response definition. Optional membership is not a null/default/staleness contract. The [official rendered station schema](https://developer.deyecloud.com/openmcp/docs/deye-open-mcp-tools.html#station_latest) corroborates the shapes, but its all-zero example is not evidence that missing, disconnected or stale sensors report zero. Missing, null, zero and invalid values must remain distinct; nothing reviewed proves which case a specific installation returns.

The official [station request sample](https://github.com/DeyeCloudDevelopers/deye-openapi-client-sample-code/blob/master/clientcode/station/obtain_station_latest.py) shows how to request the response, not how to normalize optional fields. Its raw-response printing is not a logging pattern for this project. The [measure-point sample](https://github.com/DeyeCloudDevelopers/deye-openapi-client-sample-code/blob/master/clientcode/device/obtain_device_measure_points.py) and [device-latest sample](https://github.com/DeyeCloudDevelopers/deye-openapi-client-sample-code/blob/master/clientcode/device/obtain_device_latest.py) likewise do not provide the needed installation-specific mappings.

Public-document SHA-256 fingerprints from the direct research retrieval, not installation identifiers or runtime state:

| Region | Raw Swagger document SHA-256 |
| --- | --- |
| EU | `d528052ef50e022586595dc99542162de0f56572c56d2d4fe8cbe9da63d3492f` |
| Americas | `259564f05e2fb1e0393ecf6217a481956f44a00d8b573611abf31dd75a9cd05a` |
| India | `d800602e8cb9140d7b63075d3b53bcdc59a3ca0234325ccbae2ab2f15a28b9cd` |

## Boundaries in the existing adapter

`normalizeReading` currently returns only source time, SOC and confirmed non-negative battery discharge. The owner's `powerUnit` selection confirms the discharge field; it must not silently authorize scaling every optional field. The synthetic station fixture's generation/consumption values and signed battery value are invented, not semantic evidence or a conservation equation. Explicit setup preview can show selected raw fields for comparison; that is not normalized notification support.

A station update time does not establish synchronized collection of solar, battery and grid sensors. An apparently balanced equation does not establish topology or identify an EV. A manual charging report remains separate evidence even if an aggregate home measurement is later verified. A forecast, battery threshold or nighttime-notice consent grants no overnight charging exception.

The [device schemas](https://developer.deyecloud.com/openmcp/docs/deye-open-mcp-tools.html#device_latest) offer a possible future evidence path: device collection time has an explicit seconds-based epoch description in Swagger; individual entries have key/unit/value metadata. The value declaration and numeric example are inconsistent. [Measure-point discovery](https://developer.deyecloud.com/openmcp/docs/deye-open-mcp-tools.html#device_measure_points) lists names, not a complete unit/direction contract. Device identity, point selection, scale, sign, age and multi-device aggregation would still require verification. No device poll, automatic mapping, charger detection or new integration is added here.

## Gates before implementation

1. Obtain a specific official field/device contract or owner-authorized read-only observations with independently understood reference measurements. Record unit, scale, sign, metering boundary, source time and missing-value behavior separately for each proposed field. Natural operating conditions are sufficient; do not induce faults, alter protection or issue equipment controls. Keep credentials, identifiers and raw installation responses private.
2. Start with meaningful failing behavior tests for the verified mapping. Synthetic fixtures must be labelled invented; they cannot manufacture verification. Cover missing/null versus genuine zero, invalid numbers, independent units/directions, source-time disagreement and stale/future data. Unverified fields stay unavailable.
3. Reuse the existing station response where its evidence suffices. Optional decode failures must not invalidate a valid battery reading, suppress its alert, reset latches or change confirmation/backoff. Never derive EV demand by subtraction or infer direction from field names.
4. Before persisting/rendering context, specify bounded cache data and its provenance/freshness. Cached status must add no provider refresh or KV operation. Recheck source identity/policy changes so old optional values cannot acquire a new meaning; keep battery identity and cycles intact.
5. Re-run all required checks and record request/write/bundle/CPU effects before publication. Actual station validation, production CPU, natural scheduling and owner receipt remain separate manual-release gates. If the evidence is unavailable, defer the field rather than adding guessed measurements or another provider.

This assessment closes the public-contract lookup milestone. Optional measured context remains deferred pending evidence. An optional brief cached-status view now uses the existing authorized path without a new measurement source or reserve threshold. Read-only help navigation now opens those existing status/settings handlers with expiring buttons and unchanged provider/state budgets. See [the improvement loop](IMPROVEMENT-LOOP.md).
