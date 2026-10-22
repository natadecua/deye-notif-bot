# Proposed seamless setup

**Status: automatic cloud setup and Telegram pairing are a design proposal.** The existing `npm run setup` checks Deye, previews/validates readings, collects independently selected notifications and generic charging profiles, and can send a Telegram test. `npm run preferences` now edits those non-secret preferences offline without re-entering credentials. It does **not** log in to Cloudflare, create KV, upload secrets, deploy, pair a chat automatically or provide Telegram settings menus. The existing README documents those manual deployment steps.

This proposal extends [the PRD](PRD.md) while preserving zero-cost per-owner hosting, an open-source repository and notification-only operation.

## Experience to aim for

One guided laptop setup, followed by day-to-day use in Telegram. No manual editing of namespace IDs or JSON, finding numeric chat IDs, copying credentials into commands, or keeping the laptop running afterward. A user needs their own Deye developer application, Telegram bot and Cloudflare account, but does not need a separate private GitHub repository merely to deploy from a public checkout.

Illustrative flow:

1. **Connect Cloudflare.** Open the official login/consent page, then choose the target account. Show the account and resource names before provisioning. Never ask for the user's Cloudflare password or silently turn on a paid plan.
2. **Connect Deye.** Explain how to create the developer application and obtain the credentials. Accept credentials privately in the local wizard, validate the correct regional endpoint, list stations and show friendly live readings. Require power-unit/direction/time confirmation before enabling alerts. Keep an advanced raw preview available for verification.
3. **Connect Telegram.** Explain the dedicated personal bot route through BotFather; accept the bot token in a hidden local prompt, validate it and show the bot's username. Open a pairing link/QR in Telegram so the owner taps Start. Discover the private chat from the authenticated pairing, without asking the user to find an integer ID or paste an upstream JSON response.
4. **Pick notifications.** Offer recommended battery alerts plus editable categories. Ask whether the household has an EV; only show charger/profile/planning questions when relevant. Generic charging choices are user-configured; Deepal 8 A/13 A/MAX is an example preset.
5. **Set preferences.** Confirm the installation timezone, quiet hours, profiles and electrical constraints. Planning is optional: choose an objective, house-battery reserve, car availability/energy/departure needs, and eligible optional weather settings. Unknown values disable the dependent feature, not the whole basic monitor.
6. **Create and deploy.** Provision the necessary free-compatible resources, bind them automatically, upload secrets directly to the owner's Worker and deploy a build with configuration validation. Keep the monitor disabled until required inputs are valid; only enable inbound Telegram settings after pairing and webhook authentication are configured.
7. **Verify.** Send one test notification and verify Worker bindings/configuration. Show a truthful checklist: Deye access validated, Telegram API accepted the test, owner confirmed receipt, deployment completed, Cron propagation pending/observed. Do not mark a real full/discharge cycle or production CPU budget verified just because a test message succeeded.
8. **Finish.** Explain that the laptop can be closed. Show the enabled rules in plain language, the expected cloud delay, a settings command and how to resume setup or uninstall. Offer removal of local credential files only after explicit user choice; a successful upload does not authorize deleting other local work.

Aim for a short path with advanced options collapsed. Do not promise a setup duration before validating the flow with real users. Do not call the proposed path a currently functioning one-command deploy.

## Pairing without chat-ID hunting

A proposed local pairing implementation:

- Validate the supplied personal bot with `getMe`; never log the request URL/token or whole response.
- Generate a cryptographically random one-use pairing challenge with a short expiry. It is an enrollment credential, not a Deye secret. Keep it out of logs/history and do not embed Deye credentials in the link.
- Open `https://t.me/<bot_username>?start=<challenge>` locally, optionally with a QR. Telegram documents Start payloads for deep linking.
- During initial local setup, obtain only the needed updates from the dedicated bot; accept the matching challenge in a private chat, bind the owner identity/chat and ask the person in the wizard to confirm the pairing. Ignore unrelated/stale messages. Expire/cancel the challenge and bound retries/timeouts.
- Check for an existing webhook before using `getUpdates`. Do not remove an existing integration's webhook. Offer a dedicated new bot or an explicitly chosen migration path instead.
- After the owner confirms the recipient, upload its identifiers privately and send a test. Only then configure any future inbound settings webhook, authenticated with Telegram's secret-token header and an explicit owner allowlist. Bootstrap tokens must not be reusable indefinitely.

This is a proposed sequence. `getUpdates`-based pairing is temporary local setup work; it must not become an always-running local poller. The finished monitor still runs in Cloudflare.

Telegram also documents **Managed Bots**, which can reduce bot-creation friction through an authorized manager. That is not the default here: a shared manager can obtain/manage personal bot tokens, creating a new central trust dependency. Investigate it separately before offering it, with an explicit ownership/revocation design. Dedicated BotFather-created bots remain the simpler per-owner model for v1.

## Separate owner setup from household use

The installation owner performs account/resource/secret setup once. Telegram should then present ordinary settings and reminders rather than developer credentials or raw API field names. Only explicitly authorized owners may change configuration. Family members or group recipients can receive notifications without automatically receiving administrative rights.

An illustrative Telegram settings summary:

> Battery full: on at 100%<br>
> Battery supplying power: on above 300 W, confirmed twice<br>
> Charging recommendations: on, manual session mode<br>
> Charging settings: your confirmed profiles<br>
> Goal: solar first, grid allowed before departure<br>
> Quiet hours: your chosen hours<br>
> Forecast: learning / unavailable / updated at …

The summary must reflect actual configuration, data freshness and feature readiness. A missing forecast must never look like an active weather-informed planner. Buttons such as “I set 13 A” record an action; they never command the charger. A settings preview must not trigger a fake real-condition alert.

## Provisioning and recovery requirements

Use the existing pinned Wrangler CLI for the proposed wizard's Cloudflare operations rather than collecting a broad long-lived API token. Browser OAuth consent remains the owner's action. Select the intended account explicitly; multiple accounts must not silently default to the wrong one.

Give each installation a stable identity. Re-running setup must find/reuse the installation's Worker and dedicated namespace/database rather than creating duplicates or replacing an unrelated app. Track completed steps in ignored local metadata that excludes secrets from public files. Validate remote resource ownership/name/bindings before reusing them. Never automatically delete existing resources to recover from a failed step.

Persist secrets only where needed: locally in ignored restricted files if the owner chooses, and as Cloudflare Secrets for runtime access. Do not place secrets in Wrangler `vars`, source code, GitHub Actions variables, Telegram messages, URLs generated for onboarding, or a central onboarding website. Runtime token caching in the owner's KV remains sensitive and documented.

If authentication, Deye access or Telegram pairing fails, keep the monitor disabled and explain the next concrete step. If a later deployment/test step fails after resources exist, record the real state and offer resume/disable/cleanup instructions; do not falsely report success or destroy working resources. Bounded retry/backoff and sanitized logs apply to the setup tooling as well as the Worker.

Do not add D1 just for basic full/discharge alerts. Optional history/planning can provision it later, within an updated Free-plan budget. No card, paid plan, paid push service or always-on server should be required by the default path. Provider conditions and account-wide quotas still apply.

A Cloudflare Deploy button may be offered as an alternative after its resource/secret/bootstrap behavior has been verified. It is not automatically a zero-step setup: owners still need provider accounts, consent, station selection, valid credentials and Telegram pairing. The local guided path avoids making a new GitHub repository a requirement for every user and avoids a central secret-collecting website.

## TDD acceptance cases for implementation

These tests are to be written and observed failing before implementation; they are not present or passing today.

- Cloudflare account selection is explicit and a resumed installation reuses matching resources without duplicates.
- Provisioning never selects a paid plan, replaces unrelated resources or deletes user work automatically.
- Secrets never appear in argv, generated committed files, exceptions, HTTP request logs or public setup URLs; subprocess secret upload uses private stdin/files.
- Invalid Deye access, missing readings and unconfirmed measurement units prevent enabling the monitor.
- Telegram token validation fails safely; existing webhooks are preserved unless the owner explicitly chooses a migration.
- A correct unexpired pairing challenge binds the intended private owner/chat; wrong, expired, replayed or unrelated updates cannot pair or alter settings.
- Local pairing polling has a deadline and does not remain necessary after deployment.
- A failed secret upload/deploy/test records partial progress and can resume without duplicating an installation.
- Group membership is not equivalent to administrative authorization.
- Configuration validation, a test-message API acknowledgement, owner receipt confirmation and a real observed Cron are represented as separate checks.
- The wizard and Telegram summary show independent notification choices and custom charger settings; no EV, non-Deepal, different voltage/phases and unknown telemetry are supported cases.
- All fake provider responses and account/resource identifiers in tests are explicitly synthetic.

## Sources

- [Telegram bot creation and token handling](https://core.telegram.org/bots/tutorial#obtain-your-bot-token).
- [Telegram deep links, keyboards and Managed Bots](https://core.telegram.org/bots/features).
- [Existing setup implementation](../scripts/cli.ts) and [deployment instructions](../README.md).
