# Telegram commands and manual charging reports

Commands are optional and default off. Each installation uses its own Worker, bot, allowed chat and one explicitly selected owner. All equipment adjustments remain manual. Telegram menus and buttons are the UI; no extra dashboard or always-on home computer is needed for the deployed monitor.

## What the owner can do

| Command / button | Result |
| --- | --- |
| `/start`, `/help` | Explain commands/reports/limits and offer three expiring read-only navigation buttons. |
| `/status` | Show cached SOC/discharge, source time/age, update/cooldown state, health-notice preferences, the separate charging report and optional cached weather. No Deye or weather request. |
| `/status brief` | Compact cached measurement, freshness/update state and separate manual charging evidence. Uses the same authorization and IO budget. |
| Quick status / Detailed status / Settings buttons | Open the existing cached status/settings views. Expire 30 minutes after menu creation; never change preferences or renew a report. |
| `/charging` | Report “I am charging” for six hours. This records user confirmation. |
| `/charging PROFILE_ID` | Also report one of the owner's configured profile IDs. This is not a measurement of EV power/current. |
| `/stopped` | Report “I am not charging” for six hours. It does not send a stop command to equipment. |
| Yes / No buttons | Confirm charging status from an EV-enabled discharge alert. Buttons expire 30 minutes after the source reading; old buttons cannot start a fresh session. |
| I use PROFILE buttons | After a charging report, select one of the configured profiles as manual evidence. Keeps the original report expiry and never changes equipment. |
| `/settings` | View battery notification switches/thresholds and separate health-notice preferences. |
| `/full on`, `/full off` | Change only the full notification preference. |
| `/discharge on`, `/discharge off` | Change only the sustained-discharge preference. |
| `/full_soc N` | Set the SOC trigger while preserving the strict re-arm invariant. |
| `/discharge_watts N`, `/discharge_rearm_watts N` | Set discharge trigger/re-arm values within the existing configuration constraints. |
| `/settings reset` | Remove in-chat overrides and restore the deployed preferences on the next poll. |

Example journey with synthetic values: the bot reports the house battery supplying 600 W and asks whether the owner is charging an EV. The owner presses **Yes, I'm charging**. The bot records **Source: manual confirmation**, displays its expiry and offers `/stopped`. A subsequent `/status` shows the cached battery measurement and that separate manual report. The bot still cannot establish which load caused battery discharge.

After expiry, charging status becomes **unknown**, never an invented “stopped” state. This version has no measured EV telemetry adapter. Future direct detection must identify an actual supported vehicle/charger source; aggregate house or battery readings are not EV detection.

Health notices are separately opt-in through offline `npm run health:setup` and manual deployment. Existing `/status` and `/settings` show off/on, independently chosen duration, the delivery window and paused monitoring. Muting `/full` and `/discharge` does not mute health. Configuration is not verified operation or receipt; cached status never evaluates/advances health, reflects raw metadata or adds a provider/KV operation. No new chat mutation enables health; `/settings reset` changes only existing battery overrides. Health needs neither EV hints nor bot commands. Nighttime notice consent never authorizes overnight EV charging. See [health setup and release gates](DATA-HEALTH-ALERTS.md).

Daily cached recap is independently opt-in through offline `npm run recap:setup` and manual deployment. `/settings` and detailed `/status` display the explicit local schedule and a separate paused-monitoring label; `/status brief` shows configured off/on/paused with a policy link. Configuration does not verify natural scheduling or receipt, and views never inspect/advance recap lifecycle metadata or add IO. There is no recap mutation command; `/settings reset` preserves the deployment recap policy. Muting battery categories does not mute recap. Command-disabled snapshots omit links and keep EV evidence unknown. See [recap setup, missed-date and release rules](DAILY-RECAP.md).

### A brief cached view

`/status brief` keeps battery charge/discharge, source time, freshness, unknown load breakdown, enabled/disabled monitoring, recorded cooldown/elapsed eligibility and current manual EV evidence together. `/status` retains the detailed view; `/help` lists both. Brief status labels health as configured on/off or paused, links to `/settings` for policy and to `/status` for cached forecasts/profile references. It never advances health or decodes optional weather metadata. The supported argument is exactly `brief`; other arguments keep the existing unsupported-command response.

Both views assess freshness against the exact source age before rounding displayed seconds. A reading even one millisecond beyond the limit is stale. Brief status labels future source instants separately and never describes expired/future manual reports as current. A valid manual report can coexist with stale battery data, with its own source/expiry. Unrenderable retry dates get fixed text without hiding battery data or echoing raw metadata. No output assigns an EV's share of battery discharge or grants overnight charging.

The brief reply is bounded by existing validated fields and tested within 1,000 UTF-16 code units with all configured profiles, a long timezone, extreme finite telemetry and optional features. It prints one reported profile rather than the full reference list; the detailed view remains available. It shares the existing two reads (bot and monitor), one bot replay/budget write and one Telegram reply. It does not refresh a provider, write monitor state, renew a session, add buttons/history or change the UTC command budget. Cached status and configuration never verify live connectivity or owner receipt.

### Read-only help navigation

`/help` and `/start` include one button each for **Quick status**, **Detailed status** and **Settings**. They map only to `/status brief`, `/status` and `/settings`, sharing those handlers rather than parsing a command from button text or the old Telegram message. Status reflects the cache/report at tap time, so a previously fresh reading can now be stale and an expired manual report becomes unknown. Settings shows the effective deployed/in-chat preferences. Navigation replies do not attach profile buttons or modify a report, preference, battery cycle or monitor cache.

The three fixed labels carry only a view name and creation timestamp, at most 30 ASCII bytes. Buttons are valid for less than 30 minutes; at the deadline, after it, or for a future/non-canonical/malformed timestamp, fixed guidance asks for `/help`. Unknown view names cannot invoke mutating commands and raw payloads are not echoed. Menus may remain visible after expiry. The timestamp is an age guard, not a credential or proof that a menu was issued; the existing webhook secret, sender and chat checks authorize all private access. An authorized owner can already request these views as commands. No persisted nonce, new key, hash or provider integration is needed for these read-only targets.

Help uses one bot-state read, one existing replay/budget write and one Telegram reply. A navigation tap uses one bot-state read, plus the existing monitor read for either status view; settings/invalid menus do not read monitor state. It shares one replay/budget write, one bounded callback acknowledgement and one reply. An acknowledgement failure does not suppress the reply. A failed checkpoint prevents both calls. Duplicate/rate/day limits apply; the final daily-budget notice cannot navigate or offer another menu. These are per-invocation bounds, not exactly-once guarantees under KV lag/crashes. Real Telegram menu rendering/receipt and production CPU remain unvalidated.

### Report a configured charging profile

With EV hints and confirmed profiles enabled, `/charging`, `/charging PROFILE_ID` and a valid **Yes, I'm charging** callback offer one **I use …** button per configured profile (up to 12). For example, **I use 8 A**, **I use 13 A** and **I use MAX** describe settings the owner reports using. They do not set the charger, measure its current/power, attribute battery use to it or grant an overnight exception. The normal nighttime battery priority remains the house.

Profile buttons are usable for up to 30 minutes from the charging report. Selecting one changes only the existing manual session's reported profile and preserves its original six-hour expiry. `/charging` explicitly starts/renews a report; `/stopped` replaces it with a manual “not charging” report. Status and later notifications reuse that evidence. Stopped, expired, future-dated or replaced sessions reject old profile menus. Changed/reordered profile definitions also invalidate old menus so a button cannot silently acquire a different meaning. Disabled EV hints or absent profiles omit the menu and reject its callbacks. Rejected callbacks show fixed guidance without changing the session.

Callbacks contain the session time, a bounded profile index and a short SHA-256 context of the configured EV definitions, all in at most 44 ASCII bytes. The context is a change guard, not authorization or a delivery guarantee; secret-header, owner/chat and replay checks still apply before private state access. At most one digest is computed per eligible request and is reused for validation/rendering. No new persisted field, KV operation, provider request or background refresh is added. Profile callbacks share the existing command budget, persistence-before-reply order, one acknowledgement and one reply attempt; the final budget notice cannot mutate the session. Old Telegram messages may retain visible buttons after expiry, but those callbacks are rejected.

### Distinguishing battery output, household loads and EV charging

A synthetic **315 W battery discharge** means the battery is contributing that power. It does not establish total home consumption, which appliances are running, or how much an EV is drawing. Alerts and cached `/status` label the load breakdown as unknown; with EV hints enabled they explicitly show **Household / EV split: unknown**.

The separate **EV charging** line shows either **unknown** or the owner's manual report with its expiry. Even “you confirmed charging” does not assign battery discharge to the EV or measure EV power. A valid **not charging** report suppresses EV reduction/profile advice, while preserving the battery alert and offering buttons to update the report. Once the report expires, conditional advice can return. Future-dated reports also count as unknown. With EV hints disabled, discharge alerts contain no EV advice or charging prompt.

Measuring the split would require a validated, fresh read-only source for charger/vehicle power and compatible home-load measurements. No such source is integrated. These presentation changes reuse existing readings and bot state; they add no provider calls or KV operations.

Configured profiles now appear as separate nominal reference lines in `/status` and applicable EV advice. For an owner-confirmed **230 V single-phase** setup, **8 A ≈ 1.84 kW**, **13 A ≈ 2.99 kW**, and an owner-entered **MAX of 7 kW** remain distinct choices. They are not battery-discharge thresholds or automatic detection rules: a lower battery contribution does not rule out charging because solar/grid can supply some of the demand. Other installations retain their own confirmed voltage/phases/profiles; these numbers are not universal defaults. Configure them with `npm run preferences` and explicitly deploy the saved settings.

## Enable commands on an existing installation

First complete the normal Deye/Telegram setup and KV configuration in [README](../README.md). Use a dedicated bot. In the configured chat, send `/start` from the user who will own the commands, then run:

```sh
npm run telegram:setup
```

This laptop wizard makes bounded live Telegram reads, offers human sender IDs from the configured chat, retrieves the bot username and saves a generated webhook secret plus the selected owner ID in the ignored `.dev.vars`. It does not print message contents or tokens. If a webhook already exists, it does not remove it to call `getUpdates`; use the known owner ID or a dedicated bot. Saved owner/webhook secrets are reused when re-running setup.

The wizard enables `telegram.enabled` locally and enables the Worker's public `workers.dev` address so Telegram can reach the authenticated route. Public/preview URLs remain disabled by default for notification-only installations. Only `POST /telegram/webhook` is handled; all other routes/methods return 404. The route verifies the secret header and both sender/chat IDs before accessing private state or calling Telegram.

Apply the local settings and Cloudflare Secrets to the owner's account:

```sh
npm run secrets:upload
npm run deploy
npm run telegram:webhook
```

The last command prompts for **your deployed Worker HTTPS URL ending in `/telegram/webhook`**. It refuses URL credentials/query fragments, and refuses to replace a different existing webhook. It registers message/callback updates with a secret header and one connection, keeps pending updates, and registers the Telegram command menu. API acceptance does not establish end-to-end delivery; verify `/help`, `/status`, both confirmation buttons and expiry in the owner's chat.

Setup failures show a fixed recovery hint alongside the sanitized code. In particular, an existing unrelated webhook calls for a dedicated bot; owner setup errors name the pairing/upload steps; and a command-menu failure explains that webhook registration may already have succeeded. Unknown exceptions are not echoed into these hints.

When using GitHub delivery instead, first upload the new Cloudflare Secrets locally, update the private `WORKER_CONFIG_JSON` environment secret with the new configuration, and run the manual workflow after merging the code. Then register the webhook from the owner's laptop. Deye, Telegram and owner/webhook secret values must never be placed in GitHub workflow YAML or `WORKER_CONFIG_JSON`.

Optional Cloudflare Secrets introduced by this feature:

- `TELEGRAM_WEBHOOK_SECRET`: generated 32-byte secret encoded as URL-safe text.
- `TELEGRAM_OWNER_ID`: the positive numeric user/sender ID, separate from a potentially negative group chat ID.
- `TELEGRAM_BOT_USERNAME`: used to recognize commands addressed to this bot in a group.

The ordinary `npm run secrets:upload` command now includes these named values when configured. Existing Deye/Telegram credentials are preserved. Keep generated files and identifiers out of Git. This implementation supports one authorized owner; membership in a notification group does not authorize other members.

## Freshness, settings and delivery behavior

The status cache is populated only by accepted distinct readings. Duplicate/out-of-order samples do not replace it; a failed/stale upstream request leaves the older cached reading visible with its current age and stale label. A newly upgraded installation needs a successful scheduled reading before `/status` has data. A status request does not reset latches, write monitor state or trigger a new poll.

### Cached update state

Status reads the existing monitoring record once and shows a separate **Cached update status** section, including when no battery reading exists:

| Cached situation | What status explains |
| --- | --- |
| Monitoring disabled | Scheduled monitoring is disabled; old retry times do not become promises of a new attempt. |
| Future retry threshold | A retry cooldown is recorded. The next attempt is allowed after the displayed time; a later scheduled poll may try. |
| Retry threshold reached/passed | The delay has elapsed; this does not establish that a poll ran or the service recovered. |
| No recorded delay and no battery cache | Waiting for a cached reading. |
| Battery cache and no recorded delay | No retry delay is recorded, independently of the reading's fresh/stale label. |

This is cached status, not a live connection check. A cooldown can follow a failed request or rejected telemetry; the record has no reliable cause field, so status does not invent one from counters or raw metadata. It does not expose unknown upstream/error fields or identifiers. Retry times use the existing local-time/UTC-fallback formatter. If a finite stored threshold cannot be represented as a date, a fixed unavailable note preserves the battery response without exposing its raw value or changing the threshold. Essential invalid monitor state still follows the existing fail-closed path.

Each request retains the existing bot/monitor reads, single replay write and bounded Telegram reply. It never polls Deye/weather, changes a cooldown, latches, report expiry or cached weather, or queues a health alert. A later successful scheduled reading can clear the monitor's existing cooldown; status only observes that stored result. KV can lag and no exact retry/delivery time is guaranteed. Proactive stale/restored notifications remain unimplemented and need a separate budget/design.

Battery alert readings, cached status source times and manual-report expiry use the explicit `daytimeDischarge.timeZone` when present, including the zone name and offset at that instant. Example: `2026-10-23 06:00:01 Asia/Manila (UTC+08:00)`. No separate display preference or inferred location is added; installations without the daytime timezone retain their existing UTC strings. Date/year rollover, midnight and fractional/daylight-saving offsets are rendered from absolute timestamps. Six-hour expiry, callback ages, stale labels and the UTC command-day counter do not change; repeated local hours include different offsets. Weather forecast/retrieval text stays explicitly UTC. Changing the display does not refresh a reading, renew a report or grant an overnight exception.

The optional daytime-discharge rule is configured offline with `npm run daytime:setup` and applied through manual deployment. `/settings` displays its timezone, hour window and minimum sampled duration. Chat switches/thresholds still apply, while `/settings reset` preserves this deployed daytime policy. Full-charge notifications retain their existing schedule. This feature needs no weather API and does not implement overnight reserve forecasting.

Optional Open-Meteo context is configured separately with `npm run weather:setup`. `/settings` shows weather on/off without coordinates; `/settings reset` keeps the deployed weather preference. Authorized `/status` displays cached hourly context with a separate forecast-cache age, retrieval time and provider/license attribution. This age describes retrieval, not model issuance or battery freshness. Forecast values are hidden at one hour or when validation/coverage fails; missing, failed, future-dated and wrong-location caches are unavailable. Battery data remains visible and weather can render even before a battery reading is cached. With weather disabled, the section is omitted. No coordinates or internal retry fields are shown.

Only eligible measured discharge notifications can refresh the hourly forecast cache, sharing existing monitor checkpoints. Status explains this when the forecast is unavailable; repeated commands cannot force a refresh. Weather failure/staleness produces an unavailable note while the measured alert continues. No command fetches weather, and forecasts do not detect charging or authorize a nighttime exception. The normal nighttime battery priority remains the house. Cached weather adds no status reads/writes or provider calls beyond the existing monitor read and bounded Telegram reply; CPU for decoding/rendering remains unmeasured in production.

Chat preferences live in `telegram:v1` and apply on subsequent Cron runs while commands are enabled. They override deployment preferences until `/settings reset`. Disabling Telegram commands restores use of the deployment preferences; re-enabling uses saved chat preferences. SOC/discharge thresholds can intentionally start new cycles under the existing identity rules. Switches and manual charging reports preserve battery cycles. Changing the station context clears the bot's contextual preferences/session.

Webhook payloads are capped at 8 KiB. Fresh text commands must be no more than 15 minutes old; older queued text is acknowledged and ignored. Commands use a two-second spacing guard, a cap of 48 accepted command-state writes per UTC day, and a final budget notice. Rapid commands are ignored rather than queued; wait a few seconds before retrying. Read-only commands also count because they persist a replay marker. After the daily limit, scheduled battery monitoring continues but further commands are acknowledged without replies until the next UTC day.

State is saved before replying. Each reply/callback acknowledgement has one bounded API attempt; failures can lose a command reply, so send a new `/status` if uncertain. Telegram/KV can still duplicate or lose effects across crashes/concurrent runs because KV is eventually consistent. The update-ID/rate guards and one webhook connection reduce ordinary repeats; they are not a transactional lock or an exactly-once guarantee. The Cron notification outbox keeps its existing independent bounded retry policy.

## Budget and validation

When commands are enabled, each Cron adds one bot-state read and no extra bot-state write. Cached telemetry uses the existing monitor-state checkpoint. Up to 48 normal sequential accepted commands add at most 48 bot-state writes/day; `/status` adds one cache read. Combined with the existing 864-write/day design bound, the expanded design is **912 writes/day** for one stable monitor, under the same valid-KV/no-overlap assumptions. Reads are about **960/day** if all 48 commands request status, versus the original approximately 576/day. Settings changes, extra installations, concurrent invocations and other account workloads require separate budgeting.

No paid service or runtime dependency was added. The Worker CPU budget still needs production measurement, especially for webhook requests and JSON/authentication work. Local workerd tests intercept all outbound calls; they validate routing, status/cache, authorization and manual charging callbacks without contacting real Telegram or Deye. See [validation](VALIDATION.md).

Official transport reference: [Telegram Bot API](https://core.telegram.org/bots/api) (`setWebhook`, secret header, callback acknowledgements and `setMyCommands`). The stricter payload, owner, expiry and budget policies above are project choices.
