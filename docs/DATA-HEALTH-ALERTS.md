# Optional missing-data and recovery notices

Status: **design proposal only, 2026-10-24**. No new notification, configuration property, command or state migration is implemented by this document. Current `/status` already shows cached freshness and retry context; scheduled delivery still sends only full/discharge alerts. This design is a separate informational feature, not household-reserve planning, EV detection or a service-availability monitor.

## Owner experience and opt-in

Silence can mean normal battery use, a latched event, delayed telemetry or a delivery failure. A future optional notice should explain that fresh battery measurements are missing without diagnosing the cause. It cannot announce a complete Worker/Cron/KV/Telegram outage through that same failed path, guarantee receipt or tell whether equipment is safe.

Existing installations remain off when the proposed option is absent. Enabling would require an explicit laptop choice of:

- A missing-update warning duration, in whole minutes from 15 through 120 and strictly longer than `maxAgeSeconds / 60`. No duration is silently selected. The owner's **15-minute daytime discharge tolerance is a different setting** and is not consent to a data-health threshold.
- A delivery policy: all hours, with explicit acknowledgement of nighttime informational notices, or only the existing configured daytime window. The latter requires a valid explicit `daytimeDischarge` rule and reuses its timezone/hour boundaries; there is no location/timezone inference or new lookup. The wizard must explain that changing this window also changes discharge filtering.

Neither option changes reading acceptance/freshness, the discharge trigger/duration, full/discharge notification switches or API retries. Both battery categories may be muted while separately enabled health notices remain on; the summary must make that clear. Owners without an EV or bot commands can use ordinary Telegram delivery. Off remains a complete supported choice. No new setting is added in this documentation slice.

Illustrative text only; durations/times below are synthetic, not selected installation settings:

> Battery updates delayed
>
> The latest accepted source reading is at least 30 minutes old (your warning setting).
> Last accepted reading: [formatted source time], [current age].
> Current battery charge and power are unknown. The cause is unknown; this does not establish a grid outage or an EV charging state.

For startup without an accepted reading, use “No accepted battery reading since monitoring of updates began” and omit unavailable source time, SOC and watts. A later recovery notice should say “New battery readings received”, identify two fresh distinct readings and their latest source time, and explain that this is observed telemetry recovery, not proof of continuous service. Use fixed wording and the existing explicit local-time/UTC display helper. Never reflect identifiers, upstream fields/bodies, exception text or request URLs. Health messages contain no charging advice, weather forecast, profile controls or charging-confirmation buttons.

## Evidence and bounded lifecycle

The proposed health state belongs to the existing `monitor:v1` value. Keep one bounded phase, timestamps/counters and acknowledgement flags, without history, a separate key, a daily reminder list or a growing set of episode IDs. Any candidate waiting for capacity is derived from that phase and its fixed qualification time; it is not a third queued payload with its own retry schedule.

| Situation | Required proposed behavior |
| --- | --- |
| First enabled scheduled run, including an upgrade with old/missing cache | Persist an activation anchor and begin a full warning grace period. Do not immediately send an outage/recovery message based on historical data. An old `lastReadingAt` alone does not establish that the new feature saw working updates. |
| Valid, distinct accepted reading | Advance the health source-time anchor only from accepted data; retain the activation anchor as a lower bound. No ping merely because an HTTP request succeeded. |
| Grace/warning boundary | Qualify one missing-update episode when `now - max(activationAnchor, last health-accepted source time) >= warningDuration`. The source-time anchor advances only on newer accepted readings, never on polling, retries or status requests. A latest reading still inside its normal freshness limit cannot qualify. |
| Missing, invalid, future, out-of-order or repeated data; provider error | Do not refresh that anchor or report a cause. Duplicate data never becomes evidence of resumed updates. Existing battery validation/backoff still applies. |
| Continued missing updates | One stale notice candidate for the continuous episode, with at most three attempts after admission. Expiry, abandonment or eviction consumes that candidate; no repeated reminders or renewed TTL while the episode continues. |
| Recovery candidate | Require two consecutive **accepted**, strictly increasing, fresh source timestamps, each newer than the pre-episode accepted source anchor, with a source gap no greater than `maxGapSeconds`. Failed/invalid/duplicate/out-of-order observations reset that candidate. A no-fetch cooldown tick cannot supply a sample; elapsed wall time beyond the gap/freshness limit invalidates old candidate evidence. |
| Confirmed recovery | Cancel an unsent/failed stale candidate immediately. Qualify a recovery message only if Telegram API acceptance of the stale notice was recorded for this same episode. If stale delivery was suppressed, expired, ambiguous or unacknowledged, recover silently. API acceptance is never called owner receipt. |
| Flapping after recovery | Allow a new episode only after the two-reading recovery and at least 60 minutes since the previous stale qualification. Continue observing during this cooldown; a remaining gap can qualify when both the warning duration and cooldown are satisfied. The cooldown can postpone a notice. Never emit a suppressed historical episode afterwards. |
| No recorded acceptance of the stale notice | Still recover/rearm using fresh evidence, but send no unsolicited “restored” message. KV lag or an ambiguous Telegram timeout can therefore cause a missing recovery message. |

The first recovery sample cancels/consumes any unsent stale candidate for that episode, even before the second sample confirms recovery. If no second distinct fresh sample follows, keep the original episode and do not mint another stale candidate. This conservative policy can omit a warning after a single briefly resumed sample; `/status` can still show the subsequent gap. A queued recovery message must still have its two-reading evidence and current fresh cache at send time; a later failed/invalid observation or expired evidence cancels it. It must not announce restoration during a renewed data gap.

Elapsed times use absolute instants, not wall-clock hour labels. Future persisted anchors or a backwards clock must not create a notice or negative age. Malformed optional health state suppresses health delivery with a fixed error code; do not silently reset it to spam a new cycle, and do not treat it as permission to reset valid battery latches. Essential monitor-state corruption keeps the existing fail-closed behavior.

## Windows, disabled monitoring and independent evidence

The proposed delivery choice applies to both stale and recovery notices. For an existing daytime window, evaluate **current delivery time** only; a stale source timestamp can belong to an earlier window/day. Use the existing timezone helper, start-inclusive/end-exclusive hours and a send-time recheck after waits. Do not apply the battery-discharge requirement that source and delivery share one open window to a missing-data notice.

Keep detecting elapsed gaps when scheduled invocations run outside the delivery window, but make no health send there. Each candidate expires 30 minutes after its original qualification, including time outside the window or waiting for capacity. Suppressed/expired candidates do not gain a fresh lifetime at morning opening, a midnight boundary or restart. If a candidate is still valid when the window opens, send at most that current notice. Recovery notices suppressed past expiry are also dropped. This can intentionally omit an entire overnight gap; owners wanting overnight notices must explicitly choose all hours. General quiet hours are not implemented: before adding them, apply the same suppression/expiry rules to informational health notices with no emergency bypass or catch-up flood.

`enabled: false` for the whole monitor retains its current no-KV/no-provider/no-send early return. No feature can observe the moment an offline configuration is disabled or prove a later pause from the stale stored record. An intentional pause must therefore use a staged, manual flow: turn **health only** off while monitoring is enabled, allow a successful checkpoint to cancel its pending notice, then disable the monitor. On resuming, leave health off for a successful reading/checkpoint and explicitly opt in again for a new grace period. A pause that skips these steps can be indistinguishable from a telemetry gap; do not promise automatic pause detection.

Changing health enablement, warning duration or delivery policy/window clears only health candidates and starts a new activation grace, without synthetic recovery. Changing station/measurement interpretation follows existing monitor reset rules and likewise begins health grace. A missing optional block in legacy state initializes silently. Health flags never enter the battery measurement identity or rearm a battery cycle. `/status` remains an authenticated cached view: no health timer advancement, state write, provider poll or forced refresh. A manual EV report, weather forecast, fresh telemetry or spare capacity never grants an overnight charging exception; ordinary nighttime battery priority remains the house.

## Shared two-slot outbox and delivery gates

The current decoder accepts only full/discharge events. A future implementation needs an explicitly validated event union for health notices with independent evidence rules; no dummy `Reading`, fabricated SOC/power or unchecked cast may make a missing-data event appear telemetry-backed. Preserve full/discharge decoding, IDs, latches, freshness requirements and retry behavior.

1. Keep **at most two pending events in total**, with **at most one health event**. Full/discharge retain priority and their existing relative order/retry times. If a new battery event needs a slot occupied by health, evict health and consume that health candidate. Never drop, disarm or postpone an otherwise due battery event to admit health.
2. Admit health only to spare capacity, after battery transitions. If both slots are occupied, its bounded phase can remain eligible only until its original qualification plus 30 minutes. No third retry queue, replacement candidate or expiry extension is allowed. If recovery supersedes stale, replace/cancel it for the same episode; never queue both.
3. Preserve the battery send gate: stale/invalid/failed/out-of-order Deye results do not release battery messages or weather requests. Evaluate health eligibility separately: missing-data text can be sent after a provider failure or during an existing Deye cooldown; it does not claim present battery values. Recovery requires its own fresh evidence. A health-only cooldown invocation must never call Deye, renew a token or bypass `apiRetryAt`.
4. Persist transitions/admission before any send using the invocation's first monitor checkpoint. If that write fails, send nothing. Attempt each due event once, at most **two Telegram HTTP attempts per scheduled invocation across all kinds**, using the existing one-attempt transport and attempt accounting. Record results together in at most one final monitor checkpoint, at least 1.1 seconds after the first. The existing crash-before-result-checkpoint limitation also applies to health attempt counts.
5. Health retries use the existing maximum of three attempts and approximately 5/10-minute backoff plus bounded jitter, honoring longer Telegram `Retry-After`. A health retry later than its 30-minute deadline is abandoned; no attempt while an event's own retry time is in the future. Preserve existing battery retry behavior. API acceptance flags are recorded in the final checkpoint, never equated with guaranteed delivery.

The existing `api_backoff` early return currently bypasses delivery and usually writes nothing. Supporting this proposal would require a deliberate refactor to evaluate/persist health without polling Deye, while preserving that legacy path when health is off. Do not simply set the current shared `eligibleToSend` flag true: that would also release stale battery recommendations. No weather enrichment is triggered for a health event.

KV remains eventually consistent and is not a global lock. Crashes between Telegram and the final checkpoint, concurrent invocations or stale/missing records can duplicate, lose or reorder notices and acknowledgement flags. There is no exactly-once or always-delivered guarantee, nor an independent alarm if the Worker, KV or Telegram itself is unavailable.

## Refreshed resource envelope

This is a **design calculation**, not a measurement or runtime change. On 2026-10-24 the official [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers/KV pricing](https://developers.cloudflare.com/workers/platform/pricing/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/) and [consistency notes](https://developers.cloudflare.com/kv/concepts/how-kv-works/) were rechecked: the Free baseline remains 100,000 Worker requests/day, 10 ms Cron CPU, 50 external subrequests/invocation, 100,000 KV reads/day, 1,000 KV writes/day and one write/second per key. Account workloads share quotas; recheck before release.

| Resource | Proposed maximum / change, under existing stable-KV/single-station/no-overlap assumptions |
| --- | --- |
| Schedule and normal reads | Same five-minute Cron, 288/day. At most monitor + auth reads = 576/day; optional bot read adds 288/day. Health adds no key/read or polling endpoint. |
| Accepted commands | Existing 48 normal command writes/day; all-status usage adds at most 96 reads/day. Combined read design bound remains 960/day with commands. Health does not add commands or reset their budget. |
| Scheduled writes | At most two monitor checkpoints plus one token-cache write: `3 × 288 = 864/day`. All send results share the final checkpoint. With normal commands: `864 + 48 = 912/day`, leaving only 88 of the Free account's 1,000 writes for other work under these assumptions. |
| Cooldown path | Today it commonly makes no write. Proposed health initialization/transition/cancellation may require one monitor write, or two when a health send is attempted, with no auth write. Thus **typical use can increase**, although the existing daily maximum is not expanded. Health-off paths retain existing behavior. |
| External HTTP attempts | Existing maximum six Deye attempts plus two Telegram attempts, optionally one weather GET = nine/invocation. Health competes for the two send slots; it does not add a third send. A health-only Deye-cooldown run uses at most one Telegram attempt, no Deye/weather call. |
| State and memory | One fixed-size optional health phase plus at most one health event inside the same two-event array. Target health metadata below 1 KiB serialized, with bounded validation; no retained bodies, sample history, per-day maps, extra namespace or paid service. |
| CPU | More bounded validation/transitions and existing text/time rendering. No new runtime dependency, formatter map, provider parsing or repeated hash. Both cold/warm and worst-case failure/dual-event paths must be measured in the owner's Free account against the **10 ms** Cron limit; local workerd timing is not that evidence. |

The sum of 912 is not an atomic global quota guarantee. Configuration churn, stale KV, concurrent/manual triggers, other Workers and credential work can exceed normal assumptions. A CPU termination or failed checkpoint can prevent persistence or delivery. Do not add a third checkpoint, extra key, history, polling call or send while claiming this envelope still holds. If measurements or implementation violate it, revise/reduce the design and its documented bounds before enabling delivery; do not silently require a paid plan.

## Acceptance plan and implementation gates

These are **future tests to write and observe failing**, not tests implemented or passed by this document:

| Gate | Required meaningful cases |
| --- | --- |
| Default-off configuration / pure transitions | Legacy config/state, explicit opt-in duration/window validation, no-EV path, fresh/old/missing startup grace, exact duration boundary, source-vs-poll time, a restarted episode, duplicates/out-of-order/future/invalid data, clock rollback, malformed optional metadata without battery reset. |
| Recovery / flapping | Two fresh increasing timestamps, stale candidate cancellation on first fresh sample, duplicate/invalid/long-gap interruption, no-fetch cooldowns, stale API acknowledgement required, ambiguous timeout, fresh evidence lost before send, one episode/60-minute rearm without renewed TTL. |
| Migration / policy | Preserve full/discharge latches and queued events, health-only changes, station changes, disabled monitor zero work, staged pause/resume, window boundaries and midnight/DST, expired overnight candidates and no morning replay, muted battery categories independent of health. |
| Queue / transport | Both slots occupied, health admission/eviction without losing battery events, replacement of stale with recovery, independent stale-vs-battery gates on failure/backoff, first checkpoint failure, three attempts/30-minute expiry, long Retry-After, crash after API acceptance, bounded one final checkpoint and same-key spacing. |
| Budget / local runtime | Assert per-invocation reads/writes/attempts on fresh, failed, cooldown, dual-event and health-off paths; exact serialized legacy compatibility; intercepted workerd health-only delivery with no Deye/weather call, authentication/no monitor mutation for status, fixed safe text without private fixture fields. |
| Release evidence | All four required checks and hosted CI; then a separately authorized manual release, actual owner receipt, natural scheduled gap/recovery observation, account quotas and cold/warm CPU. Synthetic fixtures must be labelled. Never induce an equipment fault or disable real protection for a test. |

Migration is one-way for new pending event kinds: the current old binary rejects unknown kinds. Before an owner manually rolls back, the future health-aware version must disable **health only** with the monitor still enabled, checkpoint removal of all health events and verify that state privately. Do not deploy an old binary over a new health event or reset the entire KV value to recover. Optional health metadata alone may be ignored by old code; unknown pending kinds cannot.

Next implementation slice: meaningful failing tests for **default-off configuration, pure health transitions and legacy-state migration**, then the smallest implementation without delivery/provider changes. Shared-queue dispatch, setup/status visibility and runtime/budget tests follow as a separate slice before health messages can be enabled. Reserve thresholds/urgent-night advice still require the owner's missing household inputs; richer measured fields and direct EV telemetry require verified sources/units.
