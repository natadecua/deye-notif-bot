# Optional quiet hours for scheduled notifications

Status **2026-10-28: design proposal only**. No quiet-hours runtime behavior, accepted configuration/state field, setup command, chat command or CI allowlist is implemented. Do not add the proposed fields to installation settings yet. Existing daytime discharge filtering, health delivery windows and recap schedules retain their current rules. This document defines the next test-first stages; the acceptance matrix below is future work, not passing-test evidence.

The goal is to let an installation owner choose when particular proactive notifications may interrupt them. Quiet hours do not pause telemetry, change the battery's operation, detect EV charging or protect an energy reserve. The owner chose Asia/Manila and 15-minute daytime discharge tolerance, but has not chosen a quiet-hours window or categories. Those choices, health/recap consent and a manual charging report are independent. Nighttime battery use remains for the house; no notification setting grants an overnight EV exception. [Reserve planning](RESERVE-ALERTS.md) still needs its household inputs.

## Explicit owner choices

A future offline flow must separately ask to enable quiet hours, explicitly enter an IANA timezone and local start/end, choose every affected category, acknowledge that these messages can be missed, then confirm a final local save. Nothing is preselected, including the window or categories. Off is supported; cancellation preserves prior settings. No secret, lookup, location inference, account upload or deployment occurs in this flow. The existing private manual deployment/CI handoff remains separate.

Proposed schema contract, not currently accepted configuration:

| Field | Future validation |
| --- | --- |
| `quietHours` omitted, or canonical `{ "enabled": false }` | Off; the off object contains only that field. |
| `enabled` | Exactly `true` for the enabled form. |
| `timeZone` | Explicit valid IANA name, at most 64 characters, using the same bounded safe-character validation as recap. Exact string match with any configured daytime and enabled recap timezone; no silent alias conversion or change to another feature. |
| `startMinute`, `endMinute` | Integers 0–1435 in five-minute steps, minutes after local midnight; distinct. No numeric-string coercion. Midnight is 0. Equal boundaries are invalid, not an implicit all-day mute. |
| `categories` | Exactly four booleans: `full`, `discharge`, `health`, `recap`; at least one true. Explicit choices include false for unselected categories. |
| `suppressionConfirmed` | Exactly `true`: consent to suppression and possible missed notifications. |

Reject extras, arrays, partial objects, invalid timezones, missing consent and unsupported future categories with one fixed safe configuration error. An invalid saved policy must fail before prompts/monitor IO, with fixed guidance to correct or omit only the local quiet-hours block. Never silently repair consent. The future CI adapter must allowlist these fields and the four nested flags before shared validation; the public template stays off by omission. No new bot mutation or persistent bot override is proposed; `/settings reset` continues to affect only its existing battery overrides.

Selecting `health` covers both missing-update and recovery notices. Selecting a category does not enable it: full/discharge switches, independent health/recap opt-in and their delivery rules still apply. Muting full/discharge does not implicitly mute health or recap. Future reserve alarms or telemetry-source categories require their own design/consent before being included; there is no guessed emergency exemption.

Send permission is the intersection of category enablement, its existing evidence/window/retry rules and the new quiet/clock gate. In particular, open quiet hours do not open a closed health daytime window, recap opportunity or discharge source/delivery window.

## Local clock and DST rules

Use the existing bounded timezone formatter, no formatter map or calendar search. Convert the caller's current absolute instant to local hour/minute. For `start < end`, quiet means `start <= minute < end`. For a midnight-crossing window, quiet means `minute >= start || minute < end`. Start is inclusive, end exclusive, also at seconds/milliseconds within those minutes. A synthetic example of 22:00–06:00 is quiet at 23:59 and 00:00 but open at 06:00; it is not this owner's selected window.

Reevaluate the actual instant at admission/weather preparation and immediately before each Telegram attempt, including after any wait. A spring-forward gap contains no instants to process. In a repeated hour, each occurrence uses its own local clock label; both are suppressed when that label is quiet. Crossing an end twice never creates another event or renews a deadline. Absolute retry times, evidence freshness, report expiry and UTC command-day budgets are unchanged. A clock jump forward skips elapsed opportunities rather than scanning dates.

To guard observed absolute-clock rollback, propose one optional `quietHours` companion in the existing monitor value: exactly `version: 1` and safe-integer `lastObservedAt` in 0–253402300799999 milliseconds since the Unix epoch, under 128 serialized bytes, with no window history or message list. The caller clock uses the same bounds. The helper copies it; valid observations never decrease its timestamp. On `now < lastObservedAt`, suppress the currently selected categories until the clock catches up; do not advance the guard or clear any other lifecycle. Policy/window/category changes do not lower this high-water mark. Missing legacy metadata initializes from a valid caller time without resetting battery/health/recap. A missing/reset/stale KV value cannot prove earlier observations; this guard is not global monotonic time.

Malformed optional guard metadata is retained with a fixed diagnostic and suppresses selected categories only; unselected categories keep their own gates. Invalid/nonfinite/out-of-range caller time likewise fails closed for selected delivery, without reflecting values or exceptions. With quiet hours off, metadata alone cannot activate suppression; remove only that companion at a successful monitor checkpoint. No status request evaluates, repairs or persists this guard. Essential state/queue corruption retains the existing fail-closed behavior.

## Suppression, evidence and expiry

Quiet hours are an additional delivery gate, not a trigger, rearm condition, paused clock or deferred-job system. Continue normal bounded Deye polling when allowed by its existing cooldown, validation of distinct fresh readings, battery latches/hysteresis, health observations, recap date resolution and ordinary event expiry. Never request Deye/auth/weather merely because a quiet window opened or closed.

| Category selected for quiet hours | Proposed result during quiet time |
| --- | --- |
| Full / discharge | Track the accepted reading/cycle normally, even if notification switches are off. A qualified enabled event uses its existing slot and original 30-minute lifetime; quiet time does not rearm or replace it. Discharge still requires its own source/delivery daytime window and confirmation duration. |
| Missing-update / recovery health | Continue the existing lifecycle and original qualification/30-minute expiry, including during Deye cooldown. Do not count suppression as Telegram acceptance. Recovery still requires recorded acceptance of its stale notice and two distinct fresh readings. |
| Daily recap | Resolve its local date normally. Keep the original less-than-15-minute opportunity and midnight cutoff. A wholly quiet opportunity is missed, with no new candidate at quiet-end or later that date. |
| Category unselected | Apply its existing enablement, evidence, priority, retry and delivery gates without a quiet-hours exemption or penalty. |

Retain eligible pending events only in the existing two-slot outbox; no hidden wake-up queue. Time spent quiet, waiting for capacity or awaiting retry counts toward each original deadline. Preserve each kind's existing exact deadline comparison. A battery message's refreshed reading may update its evidence, never its `createdAt`/identity/deadline. Health expiry must settle/consume the original candidate; recap expiry/eviction retains its resolved date. No new attempt, retry timestamp, TTL, latch reset or acknowledgement is created merely by suppressing or reopening.

At quiet-end, at most the already bounded, still-valid events may send under all their own evidence rules and original retry times; this is not replay of missed events. An expired event is discarded, even if the condition still holds. A continuing full/discharge condition does not remint its latched event. A suppressed stale notice that never recorded API acceptance cannot cause an unsolicited recovery notice. Restart, midnight, DST repeats or policy edits do not renew events. No morning digest or suppressed-message count/history is proposed.

Do not prepare a weather guard or fetch a forecast for a discharge event already blocked by quiet hours. If an existing eligible weather request was started before quiet time began, its bounded request may finish, but recheck before any send: crossing into quiet suppresses the Telegram attempt without incrementing its attempt count. Other current evidence/window/deadline checks still apply. A current user-requested `/status` may show existing cached weather; it never refreshes it.

## Shared capacity, checkpoints and configuration changes

Keep two total event slots and two scheduled Telegram attempts. Admission/dispatch priority stays battery > health > recap; battery evicts recap before health, health may preempt recap. Quiet high-priority events may occupy capacity and thus cause an unselected lower-priority event to be skipped/evicted under the existing rules. Explicitly explain that consequence; do not reorder or give lower-priority events a hidden slot. A due unselected event already admitted can still be considered after a suppressed event without spending a Telegram attempt on suppression.

Persist observations/admission/expiry and the quiet clock guard in the existing first checkpoint before any send. All results share the existing single final checkpoint, spaced at least 1.1 seconds from the first; no per-event write. Recheck quiet hours before incrementing attempts or issuing Telegram requests, after waits/checkpoint work and before the second attempt. If a guard observation, expiry or already-started weather result changes state after the first checkpoint, mark it for that same bounded final checkpoint even when no Telegram attempt follows; never add a third write. A failed first checkpoint sends nothing. API acceptance followed by a failed result checkpoint can still duplicate delivery; suppression is not an acknowledgement.

With enabled quiet hours, cooldown ticks can persist the guard and ordinary expiry in one monitor checkpoint, two if other eligible delivery occurs, without bypassing Deye cooldown or calling auth/weather there. Off with no companion retains the legacy early return/IO exactly. Off cleanup during cooldown needs at most one shared checkpoint. Whole-monitor disabled retains zero KV/provider/send work, so cleanup cannot occur while disabled.

Activation, window/category edits and opt-out take effect from the validated invocation configuration. They do not reset battery interpretation identity/latches, health grace/acceptance, recap policy/date identity or event deadlines. Existing pending events face the new gate and their original eligibility; opted-out suppression may permit a still-current event, not an expired one. Never mutate a manual charging report. A changed recap schedule still follows its own activation-date rule. Configuration cannot undo a request already started, or guarantee immediate propagation across isolates.

Before rollback to a version without quiet-hours support, explicitly turn only quiet hours off with monitoring enabled, deploy manually, and privately verify its companion cleanup checkpoint and the intended loss of suppression. Then use a compatible older binary/configuration; do not assume unknown fields are respected by old code. Preserve battery/health/recap records and their separate rollback gates. Do not reset KV or erase pending events as a shortcut. A deliberate whole-monitor pause retains the existing health/resume caveats; quiet hours cannot detect an offline configuration change or promise a new grace period on resume.

## Requested replies and configuration visibility

Quiet hours cover scheduled proactive categories only. Authenticated `/help`, `/status`, `/settings`, charging reports, callbacks and the owner's explicit setup/test requests retain their existing authorization, command budget and bounded reply path at any hour. State that scope in setup: this is not a global Telegram mute, Telegram phone-level do-not-disturb or a guarantee against other integrations. No scheduled announcement that quiet time began/ended, daily reminder, override/bypass button or unsolicited owner message is added.

Future pure offline summaries and existing authorized views must show off/on/paused configuration, explicit local window/categories and possible missed messages, separately from verified operation/receipt. “Paused” means whole-monitor disabled, not current quiet time. A current-clock label, if shown, is an evaluation of this request's configured window only, not verified suppression or a live health check; brief status should link to policy rather than grow past its existing 1,000-unit bound. Keep existing reads/replay write/reply, omit dead links with commands off, and never inspect/advance quiet or health/recap metadata as readiness. No raw state, identifier, exception or secret-bearing URL is rendered.

## Resource contract and source review

These are proposed implementation ceilings under the existing single-station, stable-valid-KV/non-overlap assumptions, not measured production performance:

| Resource | Required envelope |
| --- | --- |
| Schedule / reads | Same 288 five-minute ticks/day, existing bot/monitor/auth reads; combined documented command scenario remains 960 reads/day. No extra Cron/key/read/provider. |
| Writes | At most two monitor checkpoints plus one token write per tick: 864/day, or 912 including 48 normal command writes. Typical quiet-enabled cooldown writes can increase; no write for each suppressed event. |
| External attempts | Existing six Deye + two shared Telegram + at most one existing weather attempt = nine per invocation; quiet hours can reduce delivery/weather work, never force polling. |
| State / CPU | One less-than-128-byte clock companion, existing two events, no growing history, dependency, repeated hash, calendar scan or formatter cache. Bounded window/guard work must still be measured cold/warm on Free. |

Official documentation rechecked **2026-10-28**: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) specify 10 ms Free Cron CPU; [KV limits](https://developers.cloudflare.com/kv/platform/limits/) specify 1,000 daily writes and one write/second to the same key. The [KV consistency documentation](https://developers.cloudflare.com/kv/concepts/how-kv-works/) explains stale/negative cached reads and the lack of transactional guarantees. These source checks are not account tests. Other workloads, manual/concurrent runs, configuration churn and KV lag can exceed the calculated envelope or duplicate/lose effects. No exactly-once, timely receipt or perfect silence guarantee is valid. If measured CPU/budget cannot fit, reduce/defer the feature; do not silently require a paid plan. See [the existing budget](CLOUDFLARE-LIMITS.md).

## Future acceptance and staged implementation

No cases below ran for this design-only milestone. Meaningful observed behavioral failures must precede each implementation stage; existing compatible behavior is not retroactively labelled test-first.

| Stage | Required future evidence |
| --- | --- |
| Pure policy/window/clock foundation | Omitted/canonical off; strict exact fields/booleans/consent/zone/time/category rules; no coercions or hidden defaults; same-day/wrap/midnight/exact boundary instants; fractional offsets, DST gaps/repeated hours and forward jumps; invalid clock, rollback/catch-up, legacy initialization, immutable bounded guard and corrupt optional metadata. Constant formatter work/size; no IO/import into the Worker. |
| Monitor integration | Selected/unselected events for all kinds, quiet trigger still latches/advances evidence, unchanged expiry/attempts/Retry-After, capacity/eviction priority, at-most-two sends, no new TTL or morning replay, health acknowledgement/recovery independence, recap resolved-date preservation, weather skipped when muted and send recheck after weather/checkpoint/waits. First/result checkpoint failures, possible duplicates, cooldown cleanup, disabled zero IO, off compatibility and restart/policy/clock cases with exact shared read/write/spacing assertions. |
| Owner preparation / views / CI | Explicit opt-in/zone/start/end/category/suppression/save consent without defaults; cancellation/opt-out; invalid saved-setting recovery before prompts; matching zones without altering other features; off/on/paused and scope/receipt labels; unchanged authorized view IO/brief bound; strict nested CI allowlist and public defaults off. |
| Runtime / rehearsal / release | Actual workerd with synthetic transports proving quiet selected delivery and unselected priority without providers during cooldown, then real-helper synthetic owner rehearsal with file/environment isolation. Run all four required checks before publishing code. Hosted CI, manual release, natural window boundaries, actual receipt and cold/warm Free CPU/quota evidence remain distinct gates. |

**Next coherent implementation slice:** an isolated test-first pure policy/window/clock helper only, with observed failing synthetic acceptance and no Worker import, accepted runtime config/state field, setup command, CI enablement or installation change. Monitor delivery, owner enablement and real release follow separately after their tests. No personal window/category policy, reserve threshold or overnight EV exception is selected by this contract.
