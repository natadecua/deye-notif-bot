# Architecture and failure semantics

One owner's Cron invocation → Deye regional REST API → validated station reading → pure alert state machine → persistent KV outbox → Telegram. Configuration is a JSON Worker variable bundled by Wrangler. Credentials are Cloudflare Secrets. There is no database of users, public polling endpoint, command webhook or control endpoint.

## Modules

| File | Responsibility |
| --- | --- |
| `src/config.ts` | Validated configuration, regional host allowlist, interpretation identity |
| `src/deye.ts` | Read-only REST allowlist, account login and cached-token renewal |
| `src/reading.ts` | Strict units, SOC, timestamp and freshness validation |
| `src/alerts.ts` | Pure transitions, hysteresis, outbox data, message text |
| `src/http.ts` | Deadlines, bounded transient retries, sanitized exceptions |
| `src/telegram.ts` | Plain-text notification transport, success envelope validation |
| `src/monitor.ts` | One scheduled run, persistence, cooldowns and retry delivery |
| `src/index.ts` | Cron entry point and a 404 HTTP handler |
| `scripts/cli.ts` | Laptop-only setup, preview, Telegram tests and secret upload |

Runtime uses only standard Workers APIs: `fetch`, Web Crypto, KV and timers. npm dependencies are development/setup/test tooling, not runtime dependencies.

## Interpretation and alert state

`monitor:v1` holds a versioned, small JSON object: last accepted timestamp, two armed flags, the high-discharge counter, API cooldown and up to two pending events. Invalid persisted state fails closed with `state_invalid`; it is not silently reset. A first deployment starts both flags armed. Changing the station, region, units, timestamp mode, thresholds, freshness limits or EV settings intentionally starts new alert cycles and discards old pending events. Changing a bot/chat alone keeps battery cycles.

Accept a reading only if it has numeric SOC in `[0,100]`, numeric non-negative `dischargePower`, a valid supported timestamp no later than the current clock, and age ≤ 600 seconds by default. The station adapter requires both measurements. Convert explicitly confirmed kW to W. Never coerce empty/null values or infer direction from `batteryPower`.

Equal timestamps are duplicates; earlier timestamps are out of order. Neither advances the state machine. Invalid or stale readings reset discharge confirmation. A gap > 720 seconds between accepted readings, or elapsed wall time since the last reading, also resets confirmation. This prevents one old high reading from combining with a much later one.

Full SOC ≥ threshold queues one full event and disarms it; SOC strictly below rearm threshold arms it. While discharge is armed, each accepted reading strictly above its threshold increments the counter, capped at two; a reading at/below threshold clears it. At two it queues an event, disarms, and clears the counter. Only discharge strictly below the rearm threshold arms it again. Intermediate values cannot cause repeated discharge alerts.

“Sustained” means observed at two distinct sample times, each fresh when evaluated; it is not proof of continuous discharge between samples or of an EV load. Five-minute polling cannot see short transients or detect their cause.

## Persistent delivery outbox

A new event has a deterministic ID (`kind:readingTimestamp`), creation time, attempt count and retry time. The Worker checkpoints all transitions **before** contacting Telegram. A failed initial state write prevents sending.

On each run with a fresh accepted or duplicate reading:

1. Remove events older than 30 minutes or no longer supported by the current reading. Remove full events if SOC is below its trigger, and discharge events if power is at/below its trigger, even if hysteresis has not rearmed. An obsolete failed event does not re-trigger merely because it was removed.
2. Update pending message telemetry to this fresh reading, so a delayed amperage estimate reflects current observed discharge.
3. Attempt each due event once. Telegram `ok: true` removes it. Network failures, 429 and server errors schedule retry; most other failures abandon the event. There are at most three attempts, with backoff approximately 5 and 10 minutes plus up to 30 seconds of jitter, subject to five-minute Cron granularity. Honor longer `Retry-After`/Telegram `retry_after` values; expiry can occur before the next permitted attempt.
4. Checkpoint delivery results. This invocation spaces the two writes to the same KV key by at least 1.1 seconds, respecting the one-write-per-second limit. Timers do not count as CPU time.

An out-of-order, invalid or failed API reading suppresses pending delivery in that invocation. Dropping/exhausting an event keeps the cycle latched until its measurement crosses the rearm threshold. This bounds message storms but can lose notifications after transport failures. Logs use fixed event codes; `telegram_sent` means API acceptance, not user receipt.

## Authentication and API backoff

`auth:v1` stores a bearer token, expiry and a SHA-256 fingerprint of its credential/region context. KV contains authentication secrets: restrict access to the Cloudflare account and namespace. Password hashes must be treated as secrets because they can authenticate. Raw passwords are never stored. Setup submits the hash following Deye's official sample; TLS stays enabled and redirects are rejected.

Deye's top-level `accessToken` may already include `Bearer`; normalization prevents duplicated prefixes. `expiresIn` is interpreted as seconds, with a 60-second early refresh and KV TTL. Cached tokens with a changed fingerprint are ignored. A cached-token HTTP 401 or unsuccessful Deye JSON envelope gets one reauthentication and one repeated logical request. The reviewed schema has no stable JSON auth-error table; the generic unsuccessful-envelope fallback is intentional and may refresh once for an unrelated application error. Freshly obtained tokens are never immediately refreshed again. HTTP 403/429/5xx do not trigger this fallback.

Each Deye HTTP operation has an eight-second timeout and at most two transient attempts. In-process backoff is 500 ms plus jitter, and only occurs if any required wait is ≤ 2 seconds. Longer rate-limit waits are persisted as `apiRetryAt` and suppress later API calls until permitted. Subsequent transient errors back off 5, 10, 20, 40 then 60 minutes. Permanent API/configuration failures use a one-hour cooldown. Invalid telemetry is checked again at the next five-minute poll. KV/config/secret failures outside that path are logged safely and retried by a later Cron invocation.

A bot token can appear in Telegram's required URL path; Deye's App ID is in the authentication query. Neither request URLs nor response bodies, telemetry, station identifiers or credentials are logged. The CLI prints selected telemetry only for explicit setup/preview and prints station names only during selection. Do not add raw exception logging or request tracing.

## Consistency and gaps in guarantees

Workers KV is eventually consistent. Reads in other locations may lag **60 seconds or more**, including cached missing keys; no strong same-location guarantee can be assumed. There is no atomic compare-and-swap or cross-invocation lock. Five-minute scheduling makes conflicts less likely but does not prevent them.

The two checkpoints are not transactional with Telegram. A crash after Telegram accepts the message but before the second checkpoint can cause a duplicate. A timeout may have accepted a message remotely. Concurrent runs can overwrite state or both send the same event. Corrupted/lost state, changing configuration and token-cache visibility can also change behavior. The tests intentionally demonstrate the crash duplicate.

This project promises neither exactly-once nor at-least-once delivery, and cannot guarantee zero lost notifications. If stronger coordination becomes necessary, evaluate a single Durable Object with transactional storage; it would still need an explicit policy for ambiguous Telegram sends. That is a separate design, not a claimed property of this KV implementation.

Deye, Telegram, Cloudflare, the logger and the network can all be unavailable. There is no separate channel for outage notifications in v1. Inspect account metrics and logs periodically. The system sends advice only; it does not issue inverter/charger commands, read EV current, or adjust equipment automatically.
