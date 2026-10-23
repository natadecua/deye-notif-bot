# Open-source improvement loop

The owner requested continuing work on setup, Telegram UI, bot commands and charging confirmations. A Codex thread follow-up is scheduled every four hours. This is a development schedule; the production Worker still polls Deye every five minutes and does not run an AI agent. GitHub CI validates proposed changes. Production deployment remains manual.

## Each iteration

1. Inspect AGENTS.md, current worktrees, open PRs and CI. Preserve unfinished user work. Repair relevant failing checks before expanding the current milestone.
2. Select one concrete user journey or reproduced bug from the backlog. Define the expected behavior and how it improves the experience for a new installation owner.
3. Write a meaningful test, observe its expected failure, implement the smallest useful change and verify it. Keep runtime dependencies out and estimate added KV/CPU/API cost.
4. Run type checking, the unit/integration suite, synthetic Workers runtime tests and the build dry run. Validate changed workflow files too.
5. Publish or update a reviewable PR. Record local/mock results separately from hosted CI and live integration evidence. Update the milestone and next step here; avoid duplicate PRs or unrelated feature expansion.

The loop opens/updates PRs and repairs CI. It does not automatically merge, deploy, change credentials, register a live webhook or send unsolicited messages to other people. The owner can change the schedule or pause the recurring task in Codex.

## Current milestone: owner-authorized Telegram interaction

Implemented in the current proposed PR:

- Readable full/discharge messages with measured charge, source time and delay context.
- `/start`, `/help`, `/status`, `/settings` and bounded preference commands.
- `/charging [profile ID]`, `/stopped` and yes/no buttons on EV-enabled discharge notifications.
- Explicit manual evidence and a six-hour expiry to unknown, with no inference that an EV caused battery discharge.
- A status cache populated only by accepted readings; status commands do not add Deye polling or alter battery latches.
- Owner/chat authorization, a webhook secret, limited payloads, best-effort replay filtering and a bounded command budget.
- A local owner-pairing wizard, explicit webhook registration and a Telegram command menu.
- Reusable GitHub validation on Node.js 22/24 and manual production delivery.

Remaining installation validation: owner-configured Cloudflare/GitHub secrets and production environment, real Telegram webhook/menu/buttons, actual fresh Deye measurements, natural alert cycles and production CPU/quotas. A synthetic runtime test is not a live validation record.

Completed follow-up: Telegram setup failures include fixed, actionable recovery steps for the owner/URL/secret flow, an existing webhook owned by another integration, and partial webhook/menu success. Unknown error text is never reflected into these hints. The complete synthetic prompt walkthrough and credential-recovery checks are now implemented below; live installation validation remains pending.

Owner-requested alert clarification: battery discharge and unknown load breakdown are now labelled separately from manual EV charging reports. Active “not charging” reports hide EV reduction/profile advice; disabled EV hints produce battery-only alerts. Confirmation does not measure an EV's share of power. Existing live setup blockers remain; direct detection still needs a verified read-only source.

## Next improvements, in priority order

**Latest owner priority: household reserve during EV charging.** Tolerate short daytime cloud dips. At night, the battery is for the house only by default; overnight EV charging is a temporary exception only when the owner explicitly needs the car the next day. A normal charging report or apparent headroom must not grant that exception. The reported 32 kWh capacity, 13% grid fallback and usual 40% morning SOC do not yet determine a reserve threshold. See [the reserve-alert proposal](RESERVE-ALERTS.md) for open inputs, conditional arithmetic and acceptance requirements. Clarify those inputs before choosing personal thresholds. Reserve/exception planning remains proposed, not a deployment record.

**Completed practical slices:** the owner selected Batangas City and 15 minutes. An opt-in daytime discharge rule supports an explicit timezone, fixed hour window and elapsed fresh-sample duration. The suggested editable owner window is 06:00–18:00 Asia/Manila. `npm run daytime:setup` saves local settings without deployment; optional Telegram `/settings` displays them. The rule tolerates short dips, preserves full-charge cycles and bounds retries. Optional Open-Meteo context is now implemented as a separate opt-in feature with `npm run weather:setup`, verified units/UTC hourly data, attribution, an hourly guard and a bounded request. Its cache shares existing monitor checkpoints, so it adds no KV operations; missing forecasts do not suppress measured alerts. One public reference-city weather smoke request succeeded; owner-location/deployed integrations remain unvalidated. See [provider notes](RESERVE-ALERTS.md#optional-weather-context).

**Completed cached-status slice:** authorized `/status` now renders existing weather with an independent retrieval age and provider attribution, without new provider calls, cache writes or KV reads. Stale/invalid/future/wrong-location/insufficient-coverage forecasts are unavailable; battery data and manual reports remain independent. Weather-disabled installations keep the existing battery-only presentation. Local synthetic checks cover authorization and the unchanged state/request budget; live installation blockers remain.

**Completed setup walkthrough:** `npm run setup:demo` rehearses the shared setup/owner-pairing flows, daytime preferences and approximate weather location/eligibility with scripted answers and synthetic transports. Settings stay in memory; the standalone command reads only the public template. It ends with fixed recovery guidance and explicitly pending live checks. Replacing Deye credentials preserves the same bot/chat's owner binding; changing bot/chat clears it and disables commands until pairing. Synthetic rejection cases cover region, authentication, missing/stale/ambiguous measurements, unconfirmed units and missing sender authorization. See [walkthrough scope](SETUP-WALKTHROUGH.md).

**Completed manual-profile buttons:** charging confirmations offer up to 12 configured **I use …** choices. Selection records the existing session's profile without extending its expiry or controlling equipment. Menus are tied to the active report/current EV definitions, expire after 30 minutes, and are rejected after stopping, replacing or expiring the report, or changing/reordering/disabling profiles. The existing owner/chat/secret checks and command budget apply; one invocation-local digest adds no KV/provider operation. Local synthetic tests and workerd exercise the journey; production CPU and real Telegram remain unvalidated.

**Next coherent milestone:** show battery reading times and manual-report expiry in the explicitly configured installation timezone where available, with clear zone labels and UTC fallback for other installations. Reuse the confirmed timezone without guessing it from Deye station strings or weather coordinates; keep formatting/cache work bounded and add no API calls. Richer solar/home/grid context remains a separate slice requiring verified fields/units/direction. Reserve and urgent-night planning still require missing owner inputs. Keep production release manual and preserve live installation blockers. Do not recreate completed commands, filtering, weather/status, walkthrough or profile menus.

1. **Local-time display and richer notification context.** Use the explicit installation timezone with UTC fallback. Add optional solar/home/grid context only after each field's units/direction are verified. Missing optional values must not suppress the basic battery alerts. Reuse the existing station request.
2. **Data-health and reserve notifications.** Add bounded stale/restored and low-reserve/recovered cycles with distinct samples, hysteresis, expiry and explicit queue priorities. Re-estimate the Free-plan budget before adding alert categories.
3. **Direct EV detection, when a supported source exists.** Discover an owner-authorized, free read-only charger/vehicle telemetry source for a specific model. Keep measured, manual and unknown evidence separate, with freshness/expiry/conflict rules. House consumption or battery discharge alone is insufficient. Do not fabricate an integration or ask all owners to submit credentials to a shared service.
4. **Quiet hours, daily recap and accessible text choices.** Use confirmed local day boundaries and capped history. Keep these optional, avoid catch-up floods and preserve important safety/data context in compact messages.

## Review evidence

Each PR should state the problem and resulting journey, observed red/green tests, final check results, request/state/CPU impact, migration behavior and any real integration evidence. Keep installation identifiers, raw responses, exceptions, secrets and secret-bearing URLs out of issues and logs. The original implementation is not retroactively described as test-first.
