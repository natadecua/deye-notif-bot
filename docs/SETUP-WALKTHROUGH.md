# Rehearse the owner setup

After installing development dependencies, run:

```sh
npm run setup:demo
```

This is an automatic transcript with scripted answers and synthetic services. No account or interactive input is needed. It reads the committed public template and keeps all resulting settings in memory. It never reads `.dev.vars`, `.env`, generated `wrangler.jsonc` or credential environment variables, saves settings, fetches a forecast, registers a webhook, provisions resources or deploys. The real CLI still uses separate owner-run commands.

The walkthrough uses the same extracted setup/pairing flows as the CLI, the real read-only Deye client with an injected synthetic transport, and the existing preference helpers. It covers this battery-only example:

| Stage | Rehearsed behavior | Still needed for a real installation |
| --- | --- | --- |
| `npm run setup` | Hidden synthetic credentials, regional station selection, fresh reading, explicit units/time/direction confirmation, notification choices and a synthetic Telegram API acknowledgement | Verify real account/station access, units, direction and time; confirm actual message receipt |
| `npm run daytime:setup` | Illustrative Asia/Manila 06:00–18:00 and 15-minute tolerance | Choose installation settings and deploy explicitly |
| `npm run weather:setup` | Eligibility, approximate city-level coordinates and save confirmation; no weather lookup | Confirm eligibility and enter the owner's approximate location |
| `npm run telegram:setup` | Authorized sender selection and webhook-secret preparation using synthetic updates | Pair the real owner, upload secrets, deploy and register the webhook/menu |
| `npm run health:setup` | The real offline helper chooses illustrative daytime/all-hours policies, separately acknowledges nighttime notices, declines a changed policy, then opts out | Choose a personal duration/delivery policy separately from discharge tolerance; verify real scheduling/receipt and CPU before release |
| Private CI handoff | Fixed instructions only; no snapshot or secret is read, generated, uploaded or deployed | Prepare the owner's own `WORKER_CONFIG_JSON` in the restricted production environment; use the existing manual, main-only workflow |
| Final checklist | Live deployment, registration, receipt, Cron and CPU remain pending/unverified | Follow README and record real observations separately |

Coordinates in the rehearsal are synthetic and do not represent Batangas City. Weather defaults off in the public template. No forecast or charging report grants an overnight EV exception; the house remains the normal nighttime battery priority. EV profile choices remain available in real setup and are covered by separate synthetic journey tests; nominal ratings never measure charging power.

The health stage uses **30 minutes/daytime** and **45 minutes/all hours** as separate illustrative choices, reusing the real helper and existing daytime window. These are not owner-selected thresholds and are independent of the example's 15-minute discharge tolerance. The all-hours example includes explicit nighttime-notice consent, which never authorizes overnight EV charging. A proposed 60-minute daytime change is cancelled at final save: the actual helper throws its fixed cancellation code, and the rehearsal verifies the previous in-memory policy survives. It then explicitly saves health off in memory, so the returned demonstration configuration finishes with health omitted. Neither the public default nor owner files are changed.

The private CI handoff names `WORKER_CONFIG_JSON` without reading its value or printing a configuration snapshot. Do not copy the synthetic settings, identifiers or placeholders into a production secret. Prepare the real installation privately, follow [CI/CD setup](CI-CD.md), and run the existing manual workflow only after its release gates. This rehearsal performs no CI handoff, secret upload or deployment and establishes no account readiness. The standalone isolation test also supplies sentinel CI/token environment values and owner files; they remain unused and unmodified.

The shared preferences summary labels optional commands from local configuration only. A locally enabled flag cannot establish successful pairing, secret upload, deployment, webhook registration or message receipt. It lists the separate manual steps and owner-chat `/status` check; commands that are off leave pairing optional. Battery-only setup remains supported, and forecast context is distinct from unimplemented charging plans/overnight exceptions. The summary prints no station identifier or coordinates.

## Recovery without losing a working binding

Replacing only Deye credentials retains the Telegram owner, webhook secret and bot username if the bot token/chat stay unchanged. New Deye login details discard obsolete company/mobile context. A different Telegram token or chat clears the old owner binding and disables commands in the returned local settings until `npm run telegram:setup` pairs the intended owner. Upload/deployment/registration remain explicit steps; the deployed configuration is not changed by the local wizard.

Known setup failures use fixed guidance:

- Authentication rejected: verify developer-app credentials and the account region privately.
- No stations: check region, access and personal/company context; do not invent an identifier.
- Missing or uncertain measurements: stop and use `docs/DEYE-API.md` before enabling the monitor.
- Stale/future/ambiguous times: verify source freshness/UTC interpretation without weakening freshness checks.
- Another webhook: use a dedicated bot and preserve the other integration.
- Missing owner authorization: pair the user, upload secrets, deploy and register the authenticated webhook.
- Weather eligibility/location invalid: leave weather off or rerun its offline wizard with valid approximate coordinates.
- Health settings invalid: correct/omit only the private health block, then rerun its offline wizard; preserve battery settings and verify health-only cleanup before an older-version rollback.
- Health save declined: the actual fixed cancellation hint is shown and the previous in-memory policy is retained; no new settings are returned to save.

Declining confirmation returns no settings to save. Existing state/files are not changed by the extracted prompt flow on failure; the real CLI still performs its ordinary final file writes after success. Those writes are not transactional across files, and automatic provisioning/resume remains proposed. Unknown exceptions are sanitized rather than incorporated into recovery text.

This walkthrough validates synthetic orchestration and recovery. It does not validate terminal rendering/accessibility, actual installation accounts, Telegram receipt, distributed KV, deployment or production CPU/quotas.
