# Grid-import warnings: measurement verification and first implementation slice

Status 2026-11-03: pure decoder/confirmation foundation implemented with synthetic tests; **no deployed grid alert or production grid polling yet**. Existing battery notifications are unchanged. The owner's latest priority is warning about grid purchases, especially alongside a current EV charging report, while permitting ordinary household battery discharge at night.

## Independent rules

- Grid import is a distinct measured source, not a battery-discharge/SOC inference. A grid warning must work day and night independently of the daytime battery window and should not depend on an EV report being present.
- Preserve the owner's existing 3 kW / 15-minute daytime battery rule. Nighttime household battery use is expected; no generic nighttime discharge alarm or EV-causation claim is introduced.
- EV charging evidence remains manually confirmed/directly measured/unknown. A warning may say the owner reported charging, but cannot attribute aggregate grid import to the EV. A charging report does not grant an overnight exception.
- A household reserve/low-SOC warning is a separate future rule; the 13% grid-fallback setting is not verified import and is not an automatically chosen reserve target. Baseline household use, morning target and warning margin remain missing.

## Read-only installation discovery

Owner-authorized read-only REST discovery found station-level purchasePower and gridPower unavailable/null. Do not map null to zero. A bounded station/device listing and one batch device/latest inspection across five devices exposed TotalGridPower and ExternalCTPowerL1L2 values with W units and a device collection timestamp. Other candidates included grid voltage/current/frequency and cumulative/daily energy counters; kWh counters are not instantaneous kW import.

Only selected metadata/type/availability was printed; no device identifiers, raw upstream bodies, credentials or measured values were committed. This establishes candidate points/units/timestamp availability, **not** sign, whole-installation metering scope, zero/missing semantics or accurate import measurement. No equipment, EV current or grid protection setting was changed. The owner was asked to provide a natural grid-import reading/time from the Deye app, plus the desired grid threshold/duration. Do not intentionally induce grid draw or change equipment for verification.

Before activation, compare the correct device/point against independently understood import and export/no-import states, confirm sign and metering boundary, and verify device collection time/freshness. Keep device identity private. Source identity must include the selected device, point, direction and verification version so a changed source cannot reuse confirmation or pending advice. Do not interpret the confirmation flag in synthetic fixtures as installation evidence.

## Pure implementation

src/grid-import.ts is deliberately outside the Worker graph. decodeGridReading requires an explicit supported point, direction and confirmed independent reference; it checks unique dataList selection, exact W unit, finite number or strict decimal-string value, valid seconds-based device collection time and exact freshness. Export becomes zero import only under the confirmed direction. Missing/null/wrong unit/duplicate/stale/future/unverified samples are unavailable and never borrow battery units or station time.

advanceGridImport takes an explicitly selected threshold/re-arm/duration, bounded source identity and source readings. Distinct fresh samples spanning elapsed duration are required. Duplicates/out-of-order samples cannot advance; dips, unavailable data, excessive gaps and stale/future values cannot establish sustained import. Strict hysteresis rearms only below the re-arm value. Candidate creation latches the episode; the original candidate expires after ten minutes. Policy/source changes restart confirmation, corrupt companion metadata fails with fixed diagnostics, rollback preserves the clock high-water mark and metadata stays bounded. There is no timezone/EV dependency and no IO, mutation of inputs or growing history.

These are preparation functions only: no runtime Config/State field, setup/menu enablement, live alert delivery or queue integration is added. An adapter must retain invalid optional metadata rather than silently reset it, persist accepted transitions/candidates in existing checkpoints and keep candidate creation separate from API acceptance/owner receipt. The helper does not promise exactly-once or guaranteed delivery.

## Next coherent milestone

Obtain the pending reference/sign/scope verification and owner alarm threshold/duration; do not choose them by timeout. Then add one default-off scheduled adapter and grid event with failing tests. Define bounded grid versus battery/health/recap admission/expiry/retry priority within the existing two-slot/two-send/two-monitor-checkpoint limits. Recheck fresh source import and original expiry before each send; no stale grid advice during provider cooldown or weather waits. Optional grid failures must preserve valid battery observations/latches and suppress only grid advice. Status uses existing cache, never requests device data. Setup and authorized bot controls need separate explicit opt-in and mapping/threshold consent, with fixed recovery and rollback cleanup.

Device polling would be a real additional request; reuse one Deye client/token and a single selected-device batch, and recalculate worst-case protected-call/auth retries/QPM plus CPU before integration. Current pure stage adds no deployed provider/KV/CPU work and leaves the existing 864/912-write envelope unchanged. Do not silently increase polling frequency, add history, infer EV demand, enable optional weather/quiet categories or deploy in the automation loop.

## Pure policy/state guard hardening (2026-11-03)

Five reproduced validation defects are fixed before future integration: zero re-arm is rejected (a strict nonnegative import reading could never go below it); stored policy identity must be canonical four-element JSON with valid source/threshold/re-arm/duration; corrupt identity cannot be silently reset by policy migration or bypassed by rollback; latched state cannot retain high-import confirmation; candidate expiry must fit the supported clock range; and source keys use 1–64 ASCII letters/digits or `:_./-` so generated identities remain bounded and round-trip. Shared validation is used for both current policy and persisted identity. Valid policy/source changes and existing rollback behavior remain compatible. Callers should derive a bounded private source digest that changes with device/point/direction/verification version, rather than exposing an identifier in diagnostics.

Five added regression cases were observed failing before their fixes. The focused suite now has 15 passing cases. This remains disconnected pure preparation with no runtime/IO/bundle change. Import direction/scope/reference and the owner's alarm preferences are still missing; no further lookups or repeated owner prompts are needed unless new evidence arrives. Next remains the documented verified adapter/event integration, not another guessed mapping or live activation.
