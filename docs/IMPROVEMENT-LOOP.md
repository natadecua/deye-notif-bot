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

Completed follow-up: Telegram setup failures now include fixed, actionable recovery steps for the owner/URL/secret flow, an existing webhook owned by another integration, and partial webhook/menu success. Unknown error text is never reflected into these hints. The next setup iteration should exercise the complete synthetic prompt journey and credential-recovery behavior, before adding unrelated features.

Owner-requested alert clarification: battery discharge and unknown load breakdown are now labelled separately from manual EV charging reports. Active “not charging” reports hide EV reduction/profile advice; disabled EV hints produce battery-only alerts. Confirmation does not measure an EV's share of power. Existing setup blockers and the next synthetic setup walkthrough remain unchanged; direct detection still needs a verified read-only source.

## Next improvements, in priority order

**Latest owner priority: household reserve during EV charging.** The goal is to tolerate short cloud dips and some nighttime charging while preserving enough battery for normal household use until solar returns. The reported 32 kWh capacity, 13% grid fallback and usual 40% morning SOC do not yet determine a safe day/night threshold. See [the reserve-alert proposal](RESERVE-ALERTS.md) for the open inputs, conditional arithmetic and acceptance requirements. Clarify those inputs before choosing personal thresholds; implement this opt-in journey ahead of the general backlog below. The proposal is not runtime behavior or a deployment record.

**Completed first practical slice:** the owner selected Batangas City and 15 minutes. An opt-in daytime discharge rule now supports an explicit timezone, fixed hour window and elapsed fresh-sample duration. The suggested editable owner window is 06:00–18:00 Asia/Manila. `npm run daytime:setup` saves local settings without deployment; optional Telegram `/settings` displays them. The new rule tolerates short dips, keeps full-charge cycles, bounds retries and uses no extra API/KV operations. A weather-context API was researched ([provider notes](RESERVE-ALERTS.md#optional-weather-context)); no weather integration is active. Next coherent milestone: optional cached weather context that cannot suppress measured alerts, followed by reserve planning once baseline/target inputs are confirmed. Preserve manual production release and current installation blockers.

1. **Owner setup walkthrough and recovery.** Exercise a fresh install, an existing webhook owned by another integration, mistaken region/units, missing device fields, stale credentials and missing sender authorization. Improve fixed error-code help without logging sensitive details. Provide a synthetic guided demo that needs no accounts.
2. **Telegram profile buttons.** After confirming a charging session, offer only the owner's configured profiles as manual reports. Show session expiry and let the owner renew/clear it; never convert a nominal MAX power rating into measured amperage or control the charger.
3. **Local-time display and richer notification context.** Confirm the installation timezone. Add optional solar/home/grid context only after each field's units/direction are verified. Missing optional values must not suppress the basic battery alerts. Reuse the existing station request.
4. **Data-health and reserve notifications.** Add bounded stale/restored and low-reserve/recovered cycles with distinct samples, hysteresis, expiry and explicit queue priorities. Re-estimate the Free-plan budget before adding alert categories.
5. **Direct EV detection, when a supported source exists.** Discover an owner-authorized, free read-only charger/vehicle telemetry source for a specific model. Keep measured, manual and unknown evidence separate, with freshness/expiry/conflict rules. House consumption or battery discharge alone is insufficient. Do not fabricate an integration or ask all owners to submit credentials to a shared service.
6. **Quiet hours, daily recap and accessible text choices.** Use confirmed local day boundaries and capped history. Keep these optional, avoid catch-up floods and preserve important safety/data context in compact messages.

## Review evidence

Each PR should state the problem and resulting journey, observed red/green tests, final check results, request/state/CPU impact, migration behavior and any real integration evidence. Keep installation identifiers, raw responses, exceptions, secrets and secret-bearing URLs out of issues and logs. The original implementation is not retroactively described as test-first.
