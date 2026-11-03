# Original-checkout draft reconciliation (2026-11-03)

The owner requested publishing all project changes. The managed review branch was already pushed through `40f1343`, with green Node 22/24 CI. The original checkout still contained 14 modified/untracked draft paths based on older `main`. Its files and unfinished edits were preserved. Useful missing content is ported into the current implementation instead of replacing newer files wholesale.

| Original draft | Published reconciliation |
| --- | --- |
| `README.md` | Readable titles, custom-target wording, source time and conditional advice already exist; newer kW/local-time/command/grid guidance is retained. The missing early setup validation/type-specific timestamp explanation is added. |
| `docs/DEYE-API.md` | Recovered research link added with historical scope. |
| `docs/VALIDATION.md` | Earlier formatting red/green observations already informed the implementation; original historical record is reproduced below, separately from current results. |
| `scripts/cli.ts` | Current CLI delegates to `runOwnerSetup`; the missing draft checks are integrated there, preserving newer setup/pairing workflows. |
| `src/alerts.ts` | Newer tested implementation already includes readable full/target/discharge layout, source time, local zones, kW and independent manual evidence. Older watt-only/UTC-only code would regress it. |
| `src/monitor.ts` | Preserve the current five-minute invalid-telemetry cooldown. It already retries at the next scheduled poll without skipping an extra interval. The old zero-delay draft would permit rapid manual invocations, so its intent is covered by a reconciled next-poll regression rather than replacing bounded behavior. |
| `test/alerts.test.ts` | Full/custom-target/year-boundary tests already published; newer house-only/EV/kW behavior supersedes the older exact discharge message assertion. |
| `test/monitor.test.ts` | Next-five-minute recovery regression ported with the current bounded cooldown contract. |
| `test/preferences.test.ts` | Both revised readable-message assertions already published. |
| `docs/DEYE-NOTIFICATION-RESEARCH.md` | Recovered as dated research with current contract links; proposals are not claimed as new implemented/live support. |
| `docs/NOTIFICATION-UX.md` | Recovered as a historical UX proposal with current implementation links. |
| `scripts/setup-checks.ts` | Ported for numeric measurement validation and preview-type timestamp choices/UTC interpretations. |
| `test/setup-checks.test.ts` | All three original cases ported and labelled synthetic. |
| `test/telegram-settings.test.ts` | Already published and expanded for current immutable settings/kW behavior; the older watt-only assertions are superseded. |

## Recovered historical formatting record

The original draft records four formatting regressions added before `alertText` changed on 2026-10-22: full layout, custom target wording, discharge layout and readable UTC year-boundary time. It reports ten passes/four expected failures before implementation, then 67 relevant passes. At that time the whole suite reported 105 passes/one failure and type checking failed because a separate draft test imported a missing Telegram-settings module. Two workerd cases and a 24.77 KiB / 7.33 KiB gzip dry run passed. Those are prior draft observations, not newly repeated results or a claim that all existing code was test-first. The managed branch subsequently implemented settings and has passing complete checks recorded in VALIDATION.md.

The original report explicitly performed no live deployment/provider send for that formatting slice. Later limited live records in VALIDATION.md apply only to their named releases. Recovered documentation does not establish current source mappings, quota entitlements, owner receipt or CPU viability.

## Current port validation

Two new owner-flow acceptance tests were observed failing before integration: null discharge still reached a unit question, and timestamp choices included modes incompatible with the preview. The existing draft helper is reused after those failures; its three unit tests are recovered coverage, not newly claimed test-first development. Existing stop-case expectations were updated for the earlier failure stage. The next-poll monitor case is compatibility coverage for already-correct current behavior. No runtime code, dependency, provider poll, state field or KV/CPU budget was changed by this reconciliation. Setup-only code stays outside the Worker bundle. Current full results are recorded in VALIDATION.md and the existing PR; deployment remains manual and grid remains inactive.
