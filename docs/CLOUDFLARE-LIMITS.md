# Workers Free sizing and verified limits

Reviewed **2026-10-21** against Cloudflare's current official documentation. Limits can change; recheck before deployment and account for every other application in your account. Cloudflare's Free account quotas are not dedicated to this Worker.

| Resource | Documented Free limit | One five-minute monitor |
| --- | --- | --- |
| Worker invocations/requests | 100,000/day | 288 scheduled invocations/day; 8,640 per 30 days, 8,928 per 31 days |
| Cron Triggers | 5/account | 1 |
| Cron CPU | **10 ms/invocation** | Small JSON, state transitions and Web Crypto only; production CPU unmeasured |
| Memory | 128 MB | Two small KV values and small API responses |
| External subrequests | 50/invocation | Usually 1 Deye request; at most 6 Deye HTTP attempts + 2 Telegram attempts = 8; optional weather adds at most 1 |
| KV reads | 100,000/day | Up to 2/run = 576/day (state + auth cache) |
| KV writes | 1,000/day | Usually 1/run = 288/day; designed maximum 3/run = **864/day** |
| Writes to one KV key | 1/second | The two state checkpoints are explicitly spaced ≥ 1.1 seconds |
| KV storage | 1 GB/account | A few KB for state and token, no growing history |
| KV deletes / list operations | 1,000/day each | None in normal operation |

The read/write bounds assume a single configured Cron, one Worker, one station, no overlapping/manual invocations, valid KV responses and this implementation's bounded requests. A token is written at most once per invocation: either initially, or after refreshing a cached token. An unsuccessful fresh token is never renewed again in the same run. State is written once before delivery, plus one checkpoint after any attempted Telegram sends. Two pending alerts share that final checkpoint. This gives at most `(2 + 1) × 288 = 864` writes/day even with frequent token renewal. Typical daily use is close to 288 state writes, with rare notification checkpoints and token refreshes. Backoff/disabled runs can use less. Cancelling a disabled category's pending notification during API backoff uses at most one state write and no external API calls, within the existing bound. Custom profile settings are bounded to 12 entries and do not add KV reads/writes; production CPU remains unmeasured.

A renewal interval of roughly 60 days appears in Deye's token example; runtime always follows the actual returned `expiresIn`, not a fixed lifetime. Normal Deye polling is approximately 8,640 requests per 30-day month, plus setup/authentication/retries. Current Deye service-model notices discuss upcoming quotas/rate controls; do not assume a perpetual fixed free Deye allowance.

Worker invocation counts are conservatively budgeted against the Free request allowance. There is no dashboard, health-check traffic, public trigger endpoint, queue, paid database or centralized backend. Bundled Worker size from the local dry run is recorded in [validation notes](VALIDATION.md). Libraries used for interactive setup/testing/building are not bundled into the deployed Worker.

Optional [Telegram commands](TELEGRAM-BOT.md) add one bot-state read per Cron, plus up to 48 normal accepted command-state writes per UTC day. A status request reads the existing monitor cache and never calls Deye. Under the same stable-configuration/no-overlap assumptions, the combined write design bound is **864 + 48 = 912/day**, and reading use is approximately **576 + 288 + 96 = 960/day** if all 48 commands request status. A callback uses at most an acknowledgement plus one reply. The final command slot reports the daily limit; subsequent updates do not write/send. The two-second guard, a single webhook connection and KV markers reduce ordinary bursts, but cannot enforce a transactional global bound under concurrent/eventually-consistent reads. Extra account workloads still share quotas. The original table describes notification-only mode; webhook HTTP traffic and CPU also count and require live observation.

Optional daytime discharge filtering adds only bounded fields to the existing state and one cached timezone formatter. It does not add KV reads/writes, API calls, queue slots or history, so the above design bounds remain unchanged. Its timezone/date work adds CPU cost that has not been measured in production, including initial formatter creation.

Optional Open-Meteo context shares the existing `monitor:v1` first/result checkpoints: its hourly attempt guard is saved before the public request and up to six forecast points are saved with delivery results. There is no separate cache key, additional KV read/write, growing history or alert queue. The **864 / 912 write/day** bounds remain unchanged under the same assumptions. A stable installation can make at most about **24 weather requests/day**, only when a discharge alert needs context; full/muted/out-of-window/no-pending cycles do not call it. One optional GET adds at most one subrequest to a notification invocation (maximum **9** with core provider attempts). It has one 1.5-second attempt, a 16 KiB body cap, an hourly persisted guard and longer Retry-After handling. Configuration changes, missing/corrupted state or concurrent/stale KV reads can add requests beyond that normal bound. Production CPU, including validation/parsing/rendering, is unmeasured; the public reference-city weather smoke test does not establish deployed Free-plan behavior.

**The 10 ms CPU limit is material.** Network waits and timer waits do not count as CPU time, but parsing, hashing, validation and message formatting do. We use a dependency-free runtime and small response/state values. Local Node tests, workerd tests and deployment dry runs do **not** establish production CPU usage or Free-plan viability for every API payload. After live deployment, inspect CPU metrics/errors in your own account, especially cold/authentication runs. Any `Exceeded CPU Time Limits` failures can prevent persistence/delivery. Keep the Free plan; profile/reduce work before considering a different design. This project does not require or automatically enable a paid plan.

KV's one-write-per-second rule cannot be enforced globally by this Worker under concurrency. Do not run multiple Crons/Workers against one namespace or rapidly repeat manual polls. Other workloads can exhaust your account-wide allowance even if this monitor stays within its estimate.

## Sources

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), including the separate Cron CPU table and subrequest limits.
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
- [KV limits](https://developers.cloudflare.com/kv/platform/limits/).
- [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), including Free delete/list allowances.
- [How KV works](https://developers.cloudflare.com/kv/concepts/how-kv-works/), including eventual consistency and the 60-seconds-or-more caveat.
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), including propagation delay up to 15 minutes.

The official HTML pages were partly unavailable to the development environment's HTTP client; the corresponding current source pages in Cloudflare's public [`cloudflare-docs` repository, `production` branch](https://github.com/cloudflare/cloudflare-docs/tree/production/src/content/docs) were retrieved and inspected for all limits above. This is documentation verification, not a test against a live Free account.
