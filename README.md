# Deye battery notifications

[![Validation](https://github.com/natadecua/deye-notif-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/natadecua/deye-notif-bot/actions/workflows/ci.yml)

A small, MIT-licensed Cloudflare Worker that sends Telegram messages about a house battery. Develop and configure it on your laptop, then let a five-minute cloud Cron Trigger run it. No extra hardware, dashboard, always-on computer, inverter control, or charger control.

Each installation runs in its owner's Cloudflare account and calls Deye and Telegram directly. There is no shared credential service.

GitHub Actions validates pull requests and pushes to `main` on Node.js 22 and 24. An optional manual Cloudflare deployment workflow reruns all checks before releasing from `main`; configure the owner's `production` environment first. See [CI/CD setup](docs/CI-CD.md).

**Implementation status:** implemented and validated with synthetic local tests, a local Workers runtime, and a Wrangler deployment dry run. No real Deye credentials or Telegram bot were supplied. Live account access, actual installation units/time formats, live messages, production CPU usage, and cloud scheduling have **not** been validated by this project session. See [validation notes](docs/VALIDATION.md).

The laptop wizard supports independent notification switches and configurable charging profiles. Optional [Telegram commands](docs/TELEGRAM-BOT.md) add cached status, owner-authorized settings, expiring manual charging reports and yes/no confirmation buttons. Optional Open-Meteo forecasts can add weather context to discharge alerts. Direct EV detection, automatic profile selection and weather/history-based charging plans remain future work. The [PRD](docs/PRD.md), [setup proposal](docs/ONBOARDING.md) and [improvement loop](docs/IMPROVEMENT-LOOP.md) distinguish implemented slices from that roadmap.

## Alerts

- Full charge: SOC **≥ 100%** by default; once per cycle, rearmed strictly **below 97%**. The threshold is configurable. Starting the monitor while already full produces a full alert.
- Sustained discharge: **> 300 W** in **two distinct, fresh, consecutive readings**; rearmed strictly **below 100 W**. Repeated polls of one timestamp never count as extra readings. Readings at or below 300 W break confirmation.
- Discharge messages label **battery discharge** and an **unknown load breakdown**. This reading does not measure total home use or separate appliances from EV charging. Optional EV hints stay conditional; a current manual “not charging” report suppresses EV reduction advice. Installations with EV hints off receive battery-only alerts.
- Optional estimate when no fixed profiles are configured: `ceil(discharge W / voltage)` for single-phase, or `ceil(discharge W / (3 × line-to-neutral voltage))` for confirmed balanced three-phase. Setup requires confirmed phases, voltage and the charger's supported minimum. It never infers present EV amperage or recommends a target setting. Check present current yourself; reduce only if the resulting setting remains at or above the documented minimum. Otherwise consider pausing manually.

Messages use clear event titles and separate charge/power lines. Battery reading times and manual-report expiry use the explicitly configured daytime installation timezone, labelled with its name and UTC offset. Without that setting, existing UTC text is retained. A charge target below 100% is labelled “charge target reached”. Example without a configured timezone (synthetic):

> ⚡ House battery supplying power<br>
> Battery discharge: 800 W<br>
> Charge: 90%<br>
> Above 300 W in two distinct readings.<br>
> Load breakdown: unknown. Battery output alone does not identify individual loads or total home consumption.<br>
> Household / EV split: unknown.<br>
> EV charging: unknown<br>
> If the EV is charging, consider reducing its charging current manually. Inverter telemetry cannot identify the EV as the cause.<br>
> Approximate reduction: 4 A (single-phase) at 230 V line-to-neutral. Current EV amperage is unknown: check it first.

The example has EV hints enabled. The complete message includes the charger minimum, an explicit condition on any adjustment, and the reading's UTC timestamp. A valid manual charging report replaces “EV charging: unknown” with the owner's report and expiry; the household/EV power split remains unknown. A “not charging” report hides reduction/profile advice until the report expires or changes. If you configure discrete charging profiles, the message instead lists only those supported choices with nominal power estimates; it does not propose an unsupported intermediate reduction or infer MAX amperage. No profile is selected automatically.

## Optional daytime battery-use alert

To allow short cloud dips, use `npm run daytime:setup`. This offline wizard lets you choose the installation timezone, a fixed daytime window and the minimum high-discharge duration. It saves only the ignored local settings; apply them to an existing Worker with a separate manual deployment. For Batangas City, use **Asia/Manila**, the editable **06:00–18:00** window and **15 minutes**. The existing watt trigger stays **above 300 W** unless changed in preferences. These are owner-selected settings, not defaults for every installation.

During that window, fresh high-discharge samples must span at least 15 minutes before the alert. With normal five-minute samples this takes four readings. A low/invalid sample or a long gap restarts confirmation; repeated timestamps do not advance it. The alert stays latched until power falls below the existing rearm threshold, and starts a fresh cycle in the next local daytime window. Nighttime discharge alerts and after-window retries are suppressed; full-battery alerts keep their existing behavior. Sampling cannot establish uninterrupted discharge between readings.

The new message starts **☀️ Daytime battery use**, followed by battery discharge, SOC, the duration and configured window. It reports measured battery use regardless of whether an EV session is known. Optional charging reports/advice remain separate. Weather context can be enabled separately below; overnight reserve planning remains unimplemented.

For private configuration/CI, the optional `MONITOR_CONFIG` property is:

```json
"daytimeDischarge": {
  "timeZone": "Asia/Manila",
  "startHour": 6,
  "endHour": 18,
  "minimumMinutes": 15
}
```

Omit that property to retain the original all-day/two-reading rule, or restore that rule through the same wizard. Changing only the daytime policy cancels old discharge advice and resets its confirmation while preserving full-charge cycles. `/settings` shows the active rule when optional bot commands are enabled. See [weather options and limits](docs/RESERVE-ALERTS.md#optional-weather-context) for the next step.

The same `daytimeDischarge.timeZone` now makes battery reading/expiry labels local: for example, `22 Oct 2026, 16:24:07 Asia/Manila (UTC+08:00)`. Status and expiry use numeric dates with the same zone/offset. There is no new display-zone preference, location lookup or timezone guess from station metadata or weather coordinates. Source instants, freshness, six-hour report duration and 30-minute button limits are unchanged; UTC offsets distinguish repeated daylight-saving hours. Weather forecast/retrieval labels and the command budget's UTC day remain UTC. Applying the display change still requires a separate manual code release.

## Optional weather context

Run `npm run weather:setup` to enable Open-Meteo context locally. Confirm eligibility for its free non-commercial API and enter an approximate latitude/longitude for your installation; city-level coordinates are sufficient. The offline wizard preserves other preferences and saves only ignored `wrangler.jsonc`. Apply through a separate manual deployment; when using GitHub delivery, update the private configuration snapshot as well. No API key or additional runtime dependency is needed. Weather defaults off.

Eligible discharge notifications can include the next three hourly cloud-cover/radiation forecasts, the retrieval time and Open-Meteo/CC BY 4.0 attribution. Radiation is a previous-hour model average in W/m², not measured panel output or available charger power. The forecasts are rounded and do not predict exactly when a cloud will clear, detect EV charging or authorize overnight charging. The owner's normal nighttime policy still reserves the battery for the house.

The monitor requests weather only when a discharge notification needs it, at most once per hour under the documented stable-KV/no-overlap assumptions. It caches up to six forecast hours in existing monitor state, rejects unverified units/invalid values, and refuses stale/future/wrong-location context. A failed or unavailable forecast adds a fixed unavailable note; it does not change battery confirmation, Deye backoff or Telegram retries. Full/muted/out-of-window alerts make no weather request. The request has one attempt, a 1.5-second deadline, a 16 KiB body cap and no followed redirects. Context shares the existing state checkpoints, so no KV reads/writes are added.

`/settings` and the offline preference summary show whether weather is enabled without printing coordinates. Authorized `/status` shows existing cached forecasts with their own age, retrieval time and attribution, independently of battery freshness. At one hour the forecast becomes stale and its hourly values are hidden; missing, invalid, future-dated or wrong-location context is unavailable. Status never fetches or refreshes weather: an eligible scheduled discharge notification can populate the cache. Weather location/eligibility still use the laptop wizard. Keep [Open-Meteo's terms](https://open-meteo.com/en/terms) and [data attribution](https://creativecommons.org/licenses/by/4.0/) in mind when adapting this personal installation to other uses. A Berlin-reference smoke request verified the client against the live weather API; actual Deye/Telegram/Cloudflare delivery, owner-location forecasts and production CPU remain unvalidated.

## Rehearse setup without accounts

Run `npm run setup:demo` after `npm ci` for an automatic, labelled synthetic walkthrough. It exercises the same setup and owner-pairing prompt flows used by the real CLI, plus daytime and weather preferences, using scripted answers and intercepted services. It reads only the public template, keeps settings in memory, and does not use environment credentials, edit owner files or contact providers. The example uses battery-only notifications, an illustrative Asia/Manila daytime window and synthetic city-level coordinates; it does not configure a Batangas forecast. It ends with fixed recovery examples and the live setup/deployment checks still pending. See [the walkthrough](docs/SETUP-WALKTHROUGH.md).

## Local setup

Use Node.js **22.13 or newer**, npm, a DeyeCloud account with an OpenAPI application, a Telegram account/bot, and your own Cloudflare **Workers Free** account. Clone the repository onto your laptop:

```sh
git clone https://github.com/natadecua/deye-notif-bot.git
cd deye-notif-bot
npm ci
npm run check
npm test
npm run test:runtime
npm run test:mock
npm run build
```

These commands use synthetic data or build locally. They do not contact live Deye/Telegram accounts or deploy a Worker. npm downloads development packages. The local runtime test intercepts every outbound API request.

1. Create an application at [Deye's developer portal](https://developer.deyecloud.com/). Obtain its App ID and App Secret. Select the region that actually contains your account/station, and confirm the account has access to it. Personal and business/company contexts can have different station lists.
2. Follow [Telegram setup](#telegram-setup) below.
3. Run:

   ```sh
   npm run setup
   ```

   This command **makes live read-only Deye requests**, lists stations with pagination, lets you choose one, and previews selected fields. It asks you to verify power units, timestamp interpretation, SOC in percent, and the discharge direction against your installation/app/documentation. It hashes your password with SHA-256 locally before submitting it, following the official sample. Plaintext passwords are not saved. It can send a live Telegram test message when you choose that option.

   Default freshness: reject data older than **600 seconds**; reject every future-dated reading; reset discharge confirmation after a **720-second** reading gap. Missing, null, invalid, negative discharge or out-of-range SOC values are rejected; they never become zero. Both SOC and discharge must be available for this station adapter to process the reading.

   Setup supports an ISO timestamp with an explicit `Z`/UTC offset, or an explicitly confirmed numeric Unix timestamp in seconds/milliseconds. It **rejects offset-less local date strings** rather than guessing a timezone. If the station schema/data does not match, stop setup and consult [Deye API notes](docs/DEYE-API.md); device-point discovery is available in the read-only client, but automatic device aggregation is not implemented.

4. Successful setup writes `.dev.vars` (local credentials, mode `600`) and `wrangler.jsonc` (local non-secret settings). Both are ignored by Git. The template [wrangler.example.jsonc](wrangler.example.jsonc) starts disabled and unconfirmed. `npm run build`/`npm run dev` copy that template if no local config exists. Setup does not change your Cron in Cloudflare or deploy anything.

To preview another **live** reading after setup:

```sh
npm run preview
```

Preview does not alter alert state or send notifications. Tokens for setup/preview are kept in process memory only; the deployed monitor caches them in KV. For manual secret configuration, see [.dev.vars.example](.dev.vars.example); the password hash is also a secret. Environment variables with the listed names override the local file for CLI commands.

Rerunning setup with replacement Deye credentials preserves the existing Telegram owner/webhook binding when the bot and chat stay the same; obsolete Deye company/mobile fields are cleared. Changing the Telegram token or chat clears that binding and disables local commands until fresh owner pairing. Apply the updated settings/secrets and complete webhook registration explicitly; a local change does not alter a deployed Worker by itself. Setup failures show fixed recovery guidance for known credential, region, reading and weather errors without echoing upstream details.

## Customize notifications and charging profiles

Setup now asks which updates you want: **battery full**, **battery supplying power**, both, or neither. The original thresholds remain configurable. Disabled categories still track battery cycles, so turning a category back on does not send a stale alert for a cycle that already happened. Disabling one also cancels its pending retry. Both categories default on for older installations.

To change these preferences without re-entering credentials:

```sh
npm run preferences
```

Its Advanced section also edits SOC/discharge triggers, rearm thresholds and reading-freshness limits. This offline wizard edits only your ignored `wrangler.jsonc`; it does not read credentials, contact Deye/Telegram, or deploy. For an existing, configured installation, apply the saved settings with `npm run deploy`. For a fresh checkout, complete `npm run setup` and the deployment steps first.

The summary reports Telegram commands as enabled or off **in local configuration**. It cannot verify pairing, uploaded secrets, deployed settings, webhook registration or actual receipt. When enabled, it points to pairing, manual upload/deployment/registration and a `/status` reply check in the owner chat. When off, pairing stays optional; battery notifications work without EV hints, weather or commands. Weather context is separate from future forecast charging plans and overnight exceptions, which are not implemented. Coordinates and installation identifiers are omitted.

EV hints are optional. Users without an EV can skip the entire electrical/profile section. EV users can keep the original approximate-reduction hint, enter **up to 12 custom supported settings**, or choose an editable **8 A / 13 A / MAX** example. Every installation must confirm phases, line-to-neutral voltage, minimum current and actual selectable settings. MAX's nominal/rated power must be entered explicitly; no universal 7 kW rating or actual MAX amperage is assumed. If hints are turned off, previously confirmed profiles remain saved for later reuse.

For a **confirmed 230 V single-phase example only**, 8 A is approximately 1.84 kW and 13 A approximately 2.99 kW. A user-entered 7,000 W MAX rating is shown as a nominal estimate with unspecified amperage. Three-phase calculations use three times the confirmed line-to-neutral voltage. These are neither measured EV power nor automatic charging detection.

The configured choices appear on separate reference lines in `/status` and applicable discharge advice. Battery discharge below a profile's nominal power does not establish “house only”: solar/grid may supply part of an EV's demand. Charging status remains unknown until manually reported, and reports expire after six hours.

Profile changes and notification switches preserve battery alert cycles, including migration of the initial implementation's state identity. Changes to the station, units, thresholds or freshness interpretation still start new cycles. Optional Telegram settings apply on subsequent polls without redeployment; `/settings reset` restores the deployed preferences. See [command setup and limits](docs/TELEGRAM-BOT.md).

## Optional bot commands

After normal setup, send `/start` to your bot and run `npm run telegram:setup` on your laptop. It pairs one authorized owner and generates a webhook secret. Upload the new secrets, deploy, then run `npm run telegram:webhook` to register the owner's HTTPS endpoint and command menu. Full steps are in [Telegram bot setup](docs/TELEGRAM-BOT.md).

Use `/status` for cached battery data, `/charging` to confirm you are charging, `/stopped` when you finish, and `/settings` for notification preferences. EV-enabled discharge alerts offer **Yes, I'm charging** and **No, I'm not** buttons. Reports are explicitly manual, expire to unknown after six hours, and never establish that an EV caused battery discharge. No EV/charger detection API is integrated yet.

`/status` also explains cached update state: waiting for a reading, a recorded retry cooldown, an elapsed delay, or disabled monitoring. A future retry threshold uses the configured display timezone and means an attempt is allowed afterwards; it is not an appointment or delivery promise. The cache does not record the cooldown's cause, and an elapsed/absent delay does not prove a healthy live connection. Battery freshness, weather and charging reports stay separate. Status never fetches Deye/weather, clears a cooldown or forces a poll.

With configured EV profiles, a charging confirmation also offers **I use 8 A**, **I use 13 A**, **I use MAX**, or the owner's own labels. These buttons report the setting being used; they never change equipment or grant an overnight exception. The menu expires after 30 minutes and selection keeps the report's original six-hour expiry. `/charging` renews a report and `/stopped` replaces it with “not charging”. Old menus are rejected after a stopped/new/expired report or profile-definition change. Each interaction shares the existing command budget. See [manual profile reports](docs/TELEGRAM-BOT.md#report-a-configured-charging-profile).

## Telegram setup

1. In Telegram, open the verified **@BotFather**, use `/newbot`, and keep the bot token private.
2. Open a private conversation with your bot and send `/start`. For a group, add the bot and send a command addressed to it. Group chat IDs are usually negative.
3. Obtain your chat ID from Telegram's `getUpdates` response. To avoid putting the token into a browser address bar, shell history, screenshots, or a command-line URL, this optional command prompts for it and prints only chat IDs/types:

   ```sh
   npm run telegram:chats
   ```

   This calls your bot's live `getUpdates` method without logging the token, request URL or message contents. A bot with an active webhook cannot use `getUpdates`; use your existing integration's known chat ID or a separate bot. Do not remove someone else's webhook just to run this monitor. Notification-only mode does not read messages; optional bot commands use the authenticated webhook described above.

4. `npm run setup` stores the token and selected numeric chat ID. Alternatively copy `.dev.vars.example` to `.dev.vars` and enter just the Telegram values to run a test:

   ```sh
   npm run telegram:test
   ```

   This command sends a **live** test message. The bot token stays out of logs; Telegram requires it in the HTTPS request path internally. Keep API tracing tools and screenshots private. “Accepted” means Telegram accepted the API call, not that the user read the message.

## Deploy to your own Workers Free account

Review your local `wrangler.jsonc` and the [Free-plan budget](docs/CLOUDFLARE-LIMITS.md). The generated config has one five-minute Cron Trigger and disables public `workers.dev`/preview URLs by default. Enabling bot commands turns on the Worker's public address for authenticated `POST /telegram/webhook`; all other routes return 404. HTTP commands cannot trigger a Deye poll.

```sh
npx wrangler login
npx wrangler whoami
npx wrangler kv namespace create STATE
```

Confirm `whoami` shows the account you intend to use. If you have multiple accounts, set the top-level `account_id` in your ignored `wrangler.jsonc`. Copy the returned namespace ID into `kv_namespaces[0].id` in that file. Keep the binding name `STATE`. Use a new namespace for each independent station monitor; do not share state between Workers.

```sh
npm run secrets:upload
npm run build
npm run deploy
```

`secrets:upload` validates configuration, then uploads the named Deye/Telegram secrets to **your configured Worker** using Wrangler. It uses a mode-600 temporary JSON file and removes it afterward. It may create the Worker before the first code deployment. `.dev.vars` is for local use and is not uploaded by `wrangler deploy` automatically. `npm run deploy` validates the enabled/confirmed configuration and namespace ID, then deploys with Wrangler. Never put credentials into `vars`, the template, source code, commits, or issue reports.

This is the point where the finished monitor starts running in Cloudflare; you can turn your laptop off. Cron changes may take **up to 15 minutes** to propagate. To observe fixed event codes, use:

```sh
npx wrangler tail
```

Watch for `reading_accepted`, `reading_duplicate`, `telegram_sent`, or sanitized error codes. Tail is an operational observation tool, not a guarantee of delivery or uptime. Persistent observability is disabled by default to avoid retaining sensitive request traces. Recheck your own Cloudflare metrics for CPU use and account quotas after deployment.

For local development, `npm run dev` starts Wrangler locally. Its scheduled test endpoint is `/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*`; invoke it manually on localhost. With real secrets and enabled config this **makes live calls and can send real messages**, though its KV is local. Do not run local and production monitors simultaneously for the same chat unless you accept independent alert cycles. Wait at least a few seconds between local invocations; avoid concurrent triggers.

## Reliability and operating limits

Full behavior and failure tradeoffs are in [architecture notes](docs/ARCHITECTURE.md).

- Cloud telemetry is delayed. Logger uploads can be every one or five minutes, and station summaries can be cached for five minutes. Add the wait to the next Cron poll (up to five minutes), another distinct reading for discharge, and network/API delays. Detection commonly takes several minutes, sometimes longer. Brief full-charge/discharge events between readings may be missed. There is no guaranteed immediate detection.
- KV stores alert latches, last reading time, confirmation count, a tiny retry outbox, and cached authentication. It is **eventually consistent**, not a global lock/transaction. Concurrent runs, region changes, crashes, or Telegram timeouts can duplicate or lose alerts. No exactly-once, at-least-once, or always-delivered guarantee is made.
- Telegram retries are capped at three attempts per event, with persisted backoff and a 30-minute expiry. Delayed events require current fresh telemetry; messages are dropped if their triggering condition has cleared. Permanent failures are abandoned until the next rearmed cycle. A failed notification may therefore be missed; inspect logs and use the test command after fixing credentials.
- Deye calls time out at eight seconds and make at most two attempts per HTTP operation. Long `Retry-After` values are deferred across polls. Other failures use a persistent cooldown. There are no unlimited loops.
- Five-minute cadence uses **288 runs/day**. Notification-only KV use is about **576 reads/day and 288 state writes/day**, plus rare token renewal/notification checkpoints; the designed upper bound is **864 writes/day**. Optional bot commands add one read per Cron and at most 48 normal command-state writes/day, for a combined **912-write/day** design bound under the same no-overlap assumptions. See the [Free limits and CPU caveats](docs/CLOUDFLARE-LIMITS.md). These are estimates, not measurements of production billing/CPU.

## Troubleshooting

| Code/symptom | Action |
| --- | --- |
| `monitor_disabled` / `setup_not_confirmed` | Complete `npm run setup`; confirm units/time/direction, then redeploy. |
| `local_config_invalid_json` | Generated config is JSON; remove comments/trailing commas after manual edits. |
| `deye_secrets_invalid` | Check all Deye secret names; SHA-256 hash must be 64 hex characters. Mobile requires country code; business contexts may need company ID. |
| `deye_auth_rejected` / `deye_http_unauthorized` | Check regional host, application credentials, account login type/password, and company context. Rotate secrets with setup + `secrets:upload`. |
| Empty station list | Check regional account and business/company membership; do not choose another station by guessing an ID. |
| `deye_api_rejected` / `deye_http_rejected` | Check station permission/access and Deye's current schema/quota in its portal. Upstream messages are intentionally omitted from logs. |
| `timestamp_ambiguous` / `timestamp_invalid` | Confirm actual timestamp format and timezone; offset-less strings are unsupported. See API notes. |
| `reading_stale` / `reading_future` | Check logger connectivity, selected timestamp mode and clock/UTC interpretation. Polls continue at five-minute intervals. Do not increase age limits to hide incorrect timezone interpretation. |
| `notification_preferences_invalid` | The optional `notifications` object must include boolean `full` and `discharge` fields. Use `npm run preferences` to configure it. |
| `charging_profiles_invalid` | Verify supported settings, unique names, current minimum, nominal power and phase/voltage. An 8/13/MAX preset needs a MAX rating at least as high as its 13 A setting. |
| `measurement_missing_or_invalid` | Station must return numeric percentage SOC and non-negative discharge. Check units/device-point availability. No guessed zero or signed battery-power fallback is used. |
| `reading_duplicate` | No new telemetry timestamp yet; this is normal with cached logger/station data. |
| `reading_out_of_order` | An older server reading was ignored. Wait for a timestamp newer than the last accepted reading. |
| `api_backoff` / `deye_http_rate_limited` | Wait for persisted cooldown/Retry-After; stop other integrations overpolling the same app. Deye quotas may change. |
| Telegram 401/403/rejected or no test message | Check token, chat ID, `/start`, bot membership/permissions and whether the user blocked the bot. Re-run `telegram:test`. |
| `telegram_*rate_limited` / `telegram_network_error` | Retries are bounded and may expire; inspect connectivity and test again. An ambiguous timeout may still have delivered a message. |
| `notification_abandoned` | Three attempts failed, or a permanent error occurred; cycle stays latched. Fix cause and run a test. |
| `state_invalid` | State corruption fails closed. Back up only if necessary, pause Cron, then delete `monitor:v1` from your namespace in Cloudflare's dashboard. This resets cycles and may produce a new alert on restart. |
| `internal_error` / no Cron output | Check KV binding, namespace/account, quota, Cloudflare CPU errors/metrics and deployed Cron propagation. Never share unsanitized exception traces containing URLs. |
| Notifications repeat unexpectedly | Check for multiple deployments/local tests or overlapping Cron runs. KV cannot enforce global deduplication. Deleting state or changing station/measurement/alert thresholds starts new cycles; notification switches and EV hints/profiles preserve cycles. |

To pause, remove the Cron in Cloudflare's dashboard, or set `MONITOR_CONFIG.enabled` to `false` locally and deploy with `npx wrangler deploy` (the `npm run deploy` convenience guard requires enabled configuration). Do not delete state simply to pause. Deleting a Cron or deploying changes can take time to propagate. To uninstall, delete the Worker and its dedicated namespace in your account, then revoke the Deye application and Telegram bot credentials if no longer used.

## Contributing

See the [related-project comparison](docs/RELATED-PROJECTS.md), [CONTRIBUTING.md](CONTRIBUTING.md), [security guidance](SECURITY.md), [MIT license](LICENSE), and [API verification notes](docs/DEYE-API.md). Fixtures in `test/fixtures/` are explicitly synthetic, not recordings from a real installation. New schemas or device adapters need sanitized, consented evidence and tests before they can be treated as verified integrations.
