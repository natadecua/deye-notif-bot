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
| Final checklist | Live deployment, registration, receipt, Cron and CPU remain pending/unverified | Follow README and record real observations separately |

Coordinates in the rehearsal are synthetic and do not represent Batangas City. Weather defaults off in the public template. No forecast or charging report grants an overnight EV exception; the house remains the normal nighttime battery priority. EV profile choices remain available in real setup and are covered by separate synthetic journey tests; nominal ratings never measure charging power.

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

Declining confirmation returns no settings to save. Existing state/files are not changed by the extracted prompt flow on failure; the real CLI still performs its ordinary final file writes after success. Those writes are not transactional across files, and automatic provisioning/resume remains proposed. Unknown exceptions are sanitized rather than incorporated into recovery text.

This walkthrough validates synthetic orchestration and recovery. It does not validate terminal rendering/accessibility, actual installation accounts, Telegram receipt, distributed KV, deployment or production CPU/quotas.
