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
