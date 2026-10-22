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

Observed before the fix: **2 failed**, with `deye_http_rejected` / `retryable: false` and an empty pending Telegram outbox where one pending event was expected. After classifying HTTP 408 as transient, the same command produced **2 passed**. Deye uses its existing bounded retry/backoff; Telegram uses its existing persistent retry queue. Ambiguous timeout delivery can still duplicate a Telegram message, as already documented.

Final local verification passed: **65 unit/functional tests plus 1 workerd test**, strict TypeScript checking and a Wrangler deployment dry run. The follow-up bundle is 19.93 KiB uncompressed / 6.14 KiB gzip. No new dependencies, paid service, equipment controls or live integration testing were added. TDD is now documented in CONTRIBUTING.md and AGENTS.md for future work. The related-project search is recorded in RELATED-PROJECTS.md; third-party projects were inspected, not deployed.
