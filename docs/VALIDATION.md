# Validation record

Date: **2026-10-21**. Work was performed in the supplied `/workspace/deye-battery-notify` development environment, running Node.js 24.19.0. This session did not have access to the user's physical laptop. The repository and setup commands are intended to be used from a local laptop checkout.

## Completed locally

- TypeScript strict checking: `npm run check`.
- **63** unit/functional tests: `npm test`. They cover full/discharge alert transitions, hysteresis boundaries, restart persistence, duplicate/out-of-order timestamps, stale/future data, missing measurements, explicit W/kW conversion, timezone/epoch validation, SHA-256 hashing, authentication schema/expiry/cache invalidation, regional hosts, rate-limit backoff, redirect rejection, Telegram failures, retry exhaustion, KV write spacing/budget and crash-induced duplicate delivery.
- **1** additional workerd runtime test: `npm run test:runtime`. A compiled actual Worker runs its scheduled handler with local KV, Web Crypto, structured config bindings and fully intercepted synthetic outbound services. It confirms a full notification, persistence across a second invocation, cached authentication and HTTP 404 behavior. Miniflare's external CF metadata lookup is disabled. This test does not use a real Deye or Telegram service.
- Synthetic demonstration: `npm run test:mock`. Displays mock cycles/messages; fixtures and output are labelled synthetic.
- Wrangler deployment **dry run**: `npm run build`, with Wrangler 4.151.3. It bundles only the dependency-free Worker and validates its bindings/config format; no deployment or Cloudflare account was used. Approximately **19.86 KiB** uncompressed / **6.13 KiB** gzip at this revision (minor bundler output changes can alter this).
- Current documentation review: Deye REST Swagger/regional portal configuration, official Python sample, MCP schema and best practices; Cloudflare Workers/KV limits, pricing, consistency and Cron docs. See the source links and remaining uncertainties in [Deye API notes](DEYE-API.md) and [Cloudflare limits](CLOUDFLARE-LIMITS.md).

The workerd test caught a real compatibility difference from Node: Workers does not implement `fetch`'s `redirect: "error"`. Runtime now uses `redirect: "manual"` and rejects redirect responses without following them. The tests also demonstrate that a crash after Telegram accepts a message can duplicate it on the next run; this is a documented delivery limitation, not an exactly-once guarantee.

## Not performed

- No real credentials were supplied, entered, committed or uploaded.
- No successful live Deye authentication, station listing, reading preview, unit/sign/timezone confirmation or installation-specific schema validation.
- No live Telegram test or alert delivery; no real bot/chat ID used.
- No Cloudflare login, namespace creation, secret upload, deployed Worker, production Cron invocation or distributed-KV consistency test.
- No measurement of production CPU time or billing; Free-plan fit is a documented design estimate. The 10 ms Cron CPU limit still needs observation in the user's own account.
- No inverter/charger commands, EV-current discovery or equipment adjustment.

## First live deployment checklist

These actions belong to the installation owner and use their own accounts:

1. Run `npm run setup` on the laptop. Confirm station access, representative power units/direction, SOC scale and UTC timestamp interpretation. If v1 cannot represent the station's data, stop and resolve the adapter rather than guessing.
2. Check the Telegram setup test and `npm run telegram:test` in the intended chat.
3. Create a dedicated KV namespace, upload secrets and deploy following README.md.
4. Allow Cron propagation, inspect `wrangler tail` and account CPU/quota metrics. Verify new distinct telemetry timestamps arrive. Check actual full-charge/rearm and discharge/rearm cycles as they occur naturally.
5. Record any installation-specific live findings separately from these synthetic test results. Keep identifiers, tokens, request URLs and raw response bodies out of public reports.


## Follow-up: TDD and repository preparation (2026-10-22)

The initial implementation already had passing tests, but no claim is made that it was originally developed test-first. Its baseline was committed as `e1db47b` after all 63 unit/functional tests, the workerd test, strict type checking and a Wrangler dry run passed again.

A real HTTP 408 defect was then reproduced using TDD. The old client treated a server-side request timeout as a permanent rejection: Deye read requests were not retried, and pending Telegram alerts were abandoned. Two regression tests were written before implementation and committed separately as `29f40e2`.

Red command:

```sh
npx tsx --test --test-name-pattern='HTTP 408' test/integrations.test.ts test/monitor.test.ts
```

Observed before the fix: **2 failed**, with `deye_http_rejected` / `retryable: false` and an empty pending Telegram outbox where one pending event was expected. After classifying HTTP 408 as transient in commit `8722c5b`, the same command produced **2 passed**. Deye uses its existing bounded retry/backoff; Telegram uses its existing persistent retry queue. Ambiguous timeout delivery can still duplicate a Telegram message, as already documented.

Final local verification passed: **65 unit/functional tests plus 1 workerd test**, strict TypeScript checking and a Wrangler deployment dry run. The follow-up bundle is 19.93 KiB uncompressed / 6.14 KiB gzip. No new dependencies, paid service, equipment controls or live integration testing were added. TDD is now documented in CONTRIBUTING.md and AGENTS.md for future work. The related-project search is recorded in RELATED-PROJECTS.md; third-party projects were inspected, not deployed.


The first GitHub publication attempt targeted `natadecua/deye-battery-notify`. The authenticated GitHub integration rejected `createRepository` with `Resource not accessible by integration`; that attempt created neither a repository nor a hosted CI run. The owner subsequently created the empty public repository [`natadecua/deye-notif-bot`](https://github.com/natadecua/deye-notif-bot) and supplied its URL. Push access to that repository was verified, and it is the publication target. The included GitHub Actions workflow runs synthetic validation only; it does not deploy to Cloudflare or test live credentials.

## Follow-up: notification switches and generic charging profiles (2026-10-22)

The next implementation slice adds independent full/discharge notification switches, compatibility with omitted legacy preferences, cancellation of disabled pending alerts (including during API cooldown), and migration of the initial EV-dependent state identity without duplicate full alerts. EV display/profile changes no longer reset battery cycles.

`npm run setup` now includes notification/profile choices. The new `npm run preferences` offline command edits the ignored local config, including an optional Advanced trigger/freshness section, without secret access, provider calls or automatic deployment. Users can enter custom discrete current/nominal-power choices or select an 8 A/13 A/MAX example; every electrical setup and selectable setting needs confirmation. MAX power must be entered rather than assumed, and is never displayed as inferred actual amperage. Profile-based notifications list supported choices with nominal estimates rather than proposing unsupported intermediate settings. Disabling hints retains confirmed profiles for later reuse.

Test-first observations:

- `616eea5`: notification/profile acceptance tests were committed after **18 expected failures and 1 legacy-compatibility pass** against the previous runtime.
- `93c68c1`: the extracted onboarding interface's baseline behavior was tested before the new flow; **8 expected failures** covered choices, supported profiles, no-EV mode, confirmation and reuse.
- `71b996c`: the MAX preset test first demonstrated that a contradictory MAX rating below the preset's 13 A setting was accepted; validation was added afterward.
- `3290b14`: an explicit-input test first failed because MAX had an assumed nominal rating. The default was removed afterward.
- A later regression test first failed because turning hints off discarded saved profiles; the implementation was changed to retain them.

New workerd coverage checks that JSON configuration bindings mute the full alert while a subsequent discharge notification renders custom nominal profile estimates correctly. Every provider call remains intercepted. The UI-flow tests use injected prompts; no real Deye, Telegram or Cloudflare setup/deployment is exercised. The interactive menu adapter is type checked; the real installation wizard remains untested against live services.

The Worker dry-run bundle is approximately **24.37 KiB** / **7.15 KiB gzip**. No runtime dependencies, paid services, actual EV telemetry, charger control, session tracking, Telegram settings menu, quiet-hours implementation or weather planner were added in this slice. The Free-plan KV write/read bound is unchanged; production CPU is still unmeasured.


An additional offline-threshold test first failed before the advanced preference step existed; thresholds and freshness can now be edited without redoing Deye authentication. The final interface keeps the previously verified settings unless the user chooses to change them. Preference edits still require deployment to affect an existing cloud Worker.

Final local verification for this slice passed: **97 unit/functional tests and two workerd runtime tests (99 total)**, strict TypeScript checking, the synthetic mock demonstration and the Wrangler deployment dry run. These results establish local/mock behavior only; the live-integration and production checks listed above remain outstanding.

## Follow-up: GitHub CI and manual Cloudflare delivery (2026-10-22)

The existing GitHub workflow was expanded into reusable validation on Node.js 22/24, automatic pull-request/main validation and manual runs. Added a manual main-only production deployment workflow, serialized releases, pinned actions, monthly action-update proposals, and owner-environment setup documentation. Deye/Telegram credentials remain in Cloudflare; deployment uses only the owner's Cloudflare token/account and a private installation-configuration snapshot.

Seven acceptance tests were added before the deployment adapter implementation. Against an explicit unavailable-adapter scaffold, `npx tsx --test test/ci-deploy.test.ts` produced **7 expected failures** for preserving confirmed settings, rejecting missing/unsafe configuration, enforcing deployment policy and sequencing persistence/deployment/failure handling. After implementation all seven pass. Tests inject writes and the deployment command; none calls a real Cloudflare API.

Validation was performed in a clean managed worktree based on committed `8475a37`, preserving the original checkout's unrelated unfinished changes. This proposed CI/CD revision passes `npm run check`, **104 unit/functional tests**, **2 local workerd tests**, the synthetic demonstration and the Wrangler deployment dry run (**24.37 KiB / 7.15 KiB gzip**). Workflow files pass **actionlint 1.7.12**, downloaded from its official release with its published archive checksum verified. These local commands ran on Node.js 22.19.0. The deployment helper is laptop/CI tooling and does not add runtime dependencies or change the Worker bundle.

Hosted GitHub execution is recorded separately after publication. No production deployment, real provider notification or production CPU test was performed for this slice. A GitHub runner requires the owner-specific environment secrets in [CI/CD setup](CI-CD.md); an authenticated local connector is not a runner credential.

Hosted confirmation: [GitHub Validation run 39753198943](https://github.com/natadecua/deye-notif-bot/actions/runs/39753198943) passed both Node.js 22 and 24 jobs on the published CI/CD revision. Each job completed type checking, unit/integration tests, the synthetic Workers runtime tests/demonstration and the build dry run successfully. The workflow is proposed in [PR #1](https://github.com/natadecua/deye-notif-bot/pull/1). The GitHub CLI account was denied repository-admin access (HTTP 403) when attempting production-environment setup; no environment or secrets were created through that attempt. The owner must configure those before using deployment.

## Follow-up: improvement loop and optional Telegram commands (2026-10-22)

The owner requested an ongoing product-improvement loop. A four-hour Codex thread follow-up was created and confirmed active. Its prompt inspects the backlog/CI, implements one coherent tested improvement, updates a reviewable PR, preserves the original checkout and keeps production merges/deployment manual. The repository backlog is [IMPROVEMENT-LOOP.md](IMPROVEMENT-LOOP.md); contribution/issue templates capture user journeys without private installation data.

The first slice adds an opt-in owner/chat/secret-authorized webhook, cached `/status`, help/menu, settings overrides, `/charging [profile ID]`, `/stopped` and yes/no buttons on EV-enabled discharge alerts. Reports explicitly come from the user and expire to unknown after six hours. No measured EV telemetry, charger/inverter control or inference of EV causation was added. The prior readable-message change and its four regression tests were carried into this proposed PR.

Observed test-first evidence:

- Bot/settings acceptance tests first produced **19 expected failures and 2 compatibility passes** against a 404/no-command scaffold, before implementing authorization, state, replies or settings parsing.
- Owner-candidate/webhook registration, conditional CI public-URL support and the carried message-layout tests were run before their implementations; the combined selection produced **11 expected failures and 35 passes**. One copied settings test was corrected to check immutability against the actual template defaults, rather than incorrectly assuming notification preferences were absent.
- A follow-up regression test first demonstrated that a future-dated manual report was displayed as present confirmation (**1 failure, 2 passes**). The summary now treats it as unknown.

Final local verification passes **140 unit/functional tests**, strict TypeScript checking, **3 workerd tests**, the synthetic demonstration, workflow actionlint and a Wrangler build dry run (**38.26 KiB / 11.06 KiB gzip**). The new workerd case exercises actual Worker HTTP routing with synthetic Telegram calls/local KV: wrong-secret rejection, cached status, callback acknowledgement, a manual session and subsequent discharge buttons. All Deye/Telegram traffic is intercepted. The setup wizard's helper logic is unit tested and its interactive adapter is type checked; the actual prompts and real service registration remain untested.

The runtime remains dependency-free. Notification-only behavior retains its original write bound; opt-in commands add a read per Cron and at most 48 normal sequential command-state writes/day for an estimated **912 combined writes/day** under documented no-overlap assumptions. Cached status adds no Deye polling or monitor-state write. Eventual consistency still permits duplicate/lost effects. Production CPU, real owner pairing/webhook/menu/button delivery, and actual account quotas have not been measured or tested for this slice. No live secret upload, deployment, webhook registration or notification was performed.

Hosted confirmation for the expanded slice: [GitHub Validation run 39755931586](https://github.com/natadecua/deye-notif-bot/actions/runs/39755931586) passed all steps in both Node.js 22 and 24 jobs, including the new webhook/status/manual-confirmation workerd test. This confirms hosted synthetic validation, not production deployment or live bot delivery.

## Iteration: actionable Telegram setup recovery (2026-10-22)

The scheduled improvement loop inspected the open PR and its green hosted checks, then selected one setup/recovery improvement. CLI failures now add fixed next-step guidance for an existing unrelated webhook, invalid URL/owner/secret configuration, provider setup rejection and partial webhook/menu success. The hints accept fixed error codes only and do not reflect unknown exceptions, response bodies, URLs or secret values.

Before implementation, the new recovery acceptance cases produced **2 expected failures** alongside **5 passing helper tests**. After implementation, `npm run check`, **143 unit/functional tests**, **3 synthetic workerd tests** and `npm run build` pass. The Worker bundle remains **38.26 KiB / 11.06 KiB gzip**; this is CLI-only behavior with no added runtime work, requests or KV writes. Helper guidance is unit tested and the CLI integration is type checked; no live setup, credential change, webhook registration or deployment was performed. The existing owner-side production-environment/secret setup requirement is unchanged. Next: complete the synthetic setup prompt walkthrough and credential-recovery cases.

## Iteration: distinguish battery contribution from household/EV demand (2026-10-22)

The owner supplied a 315 W alert and asked how to distinguish household discharge from their 8 A / 13 A / 7 kW MAX charging choices. Alerts and cached status now label measured battery discharge and an unknown load breakdown. EV-enabled messages keep the household/EV split unknown even with a manual charging report. Active “not charging” reports suppress EV reduction/profile advice; expired/future reports are unknown. EV-disabled discharge alerts omit EV advice. Configured profiles appear on separate nominal reference lines, including on `/status`; they are never detection thresholds. Solar/grid can supply part of charging demand, so a smaller battery contribution cannot classify a load as household-only.

Observed test-first evidence: the selected alert/status/manual-evidence cases produced **7 expected failures** before implementation, then **7 passes**. After the owner's profile clarification, status-reference and profile-layout cases produced **2 expected failures** before their implementation, then **2 passes**. Fixtures are synthetic and the 230 V single-phase / 7 kW MAX example is explicitly configured, not assumed for other installations. Existing runtime coverage also checks the new split labels and separate manual evidence.

Final local validation: `npm run check`, **148 unit/functional tests**, **3 synthetic workerd tests** and `npm run build` pass. The dry-run bundle is **39.53 KiB / 11.38 KiB gzip**. Rendering reuses the existing bot-state read and accepted-reading cache; there are no added provider requests, KV operations, runtime dependencies or state-schema migrations. Freshness, latches, distinct samples, retries and delivery limitations remain unchanged. Production CPU is unmeasured. No live Deye/Telegram request, configuration/secret upload, webhook registration, merge or deployment was performed. The owner-side installation blockers and next synthetic setup walkthrough remain as documented in [IMPROVEMENT-LOOP.md](IMPROVEMENT-LOOP.md).

## Requirements clarification: household reserve during EV charging (2026-10-22)

Documentation now prioritizes reserve-aware EV advice, following the owner's reported 32 kWh capacity, 13% grid fallback and usual 40% morning SOC. [RESERVE-ALERTS.md](RESERVE-ALERTS.md) separates those observations from unconfirmed sunset SOC/morning targets/windows/margins, gives conditional budget arithmetic and defines acceptance requirements. This is a proposal only: no runtime/configuration behavior or personal threshold was changed. `git diff --check` passes; documentation-only work does not require new behavior tests. The preceding code revision's [hosted validation](https://github.com/natadecua/deye-notif-bot/actions/runs/39792888014) passed Node.js 22/24; that evidence remains synthetic. No live account call, device control, merge or deployment was performed.

## Iteration: daytime battery-use notification and weather research (2026-10-22)

The owner simplified the immediate goal to daytime battery-use alerts, selected Batangas City and chose a **15-minute** tolerance for cloud dips. The implementation adds optional `daytimeDischarge`: an explicit timezone, fixed same-day hour window and elapsed high-sample duration. The proposed editable owner settings are **Asia/Manila, 06:00–18:00, 15 minutes**, retaining the existing >300 W trigger. It does not detect EV load or implement overnight reserve/weather forecasting. All installations default to their prior behavior unless configured. No actual private configuration or deployment was changed.

Observed test-first evidence: **8 expected acceptance failures** preceded runtime implementation (duration, timezone validation, short dips, duplicate/gap behavior, window/daily boundaries, full-cycle preservation, invalid polls and after-window retries). The offline setup helper first produced **3 failures** against an explicit unavailable scaffold. Settings visibility and a checkpoint crossing the window boundary produced **2 failures** before their fixes. The CI allowlist case first failed to accept the new policy; it now preserves supported fields and rejects extra nested fields. A later summary regression first failed because the preferences UI still claimed two-reading confirmation, then passed after the display was updated.

Final local validation passes `npm run check`, **162 unit/functional tests**, **4 synthetic workerd tests** and `npm run build` (**44.27 KiB / 12.44 KiB gzip**). The added workerd test resumes a seeded synthetic elapsed-duration record with local KV and intercepted providers, exercising timezone formatting and the actual scheduled handler. Prompt tests inject answers; the real interactive wizard and actual installation were not exercised. The existing KV keys/checkpoints and two-event outbox remain bounded, with no extra requests or KV operations; design limits remain 864 writes/day without commands and 912 with ordinary bounded commands under documented assumptions. A single cached timezone formatter adds unmeasured production CPU, including cold creation. All delivery/eventual-consistency limitations remain.

Official Open-Meteo/Forecast.Solar documentation was browsed for free-service eligibility and forecast fields; see [provider notes](RESERVE-ALERTS.md#optional-weather-context). The attempted public geocoding-page fetch was unavailable through the browsing tool; no live weather lookup or forecast was validated. No real Deye/Telegram call, webhook registration, secret upload, merge, equipment control or deployment was performed. Next: optional cached weather context with explicit freshness/attribution and a recalculated budget; measured daytime alerts must work without it. Reserve planning still needs the missing baseline/target inputs.

## Owner policy correction: house-only nighttime battery use (2026-10-22)

The requirements now explicitly reserve nighttime battery use for the house by default. Overnight EV charging is a per-departure exception only when the owner says the car is needed the next day; an ordinary charging report or estimated headroom cannot grant it. The proposal calls for explicit temporary confirmation/expiry and separately chosen reserve/grid preferences. This documentation correction changes no runtime behavior, bot command, private configuration or deployment. `git diff --check` passes; no new behavior tests are required for these documentation-only changes. The previously tested daytime alert still suppresses nighttime discharge notifications and does not control charging or implement the proposed exception flow.
