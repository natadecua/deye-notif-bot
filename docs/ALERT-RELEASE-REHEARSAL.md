# Synthetic alert release rehearsal

Run `npm run alerts:demo` after installing the locked development dependencies. This is a script for reviewing the new alert journey; it does not configure or release an installation. The separate `npm run setup:demo` still rehearses the older complete onboarding flow unchanged.

## What it exercises

The public committed template supplies synthetic prerequisites. The real `configureGrid`, authorized Telegram handlers and scheduled monitor are reused with in-memory KV, a virtual clock and an injected transport. Reference flags, device/sign choices and consent answers are invented fixtures, not installation evidence or owner choices. The script has no environment, owner-file, subprocess or global-fetch capability; its CLI adapter reads only `wrangler.example.jsonc` relative to the script, even when launched elsewhere.

1. Grid setup with explicit point/sign/reference, illustrative 1 kW threshold, 0.1 kW re-arm, ten minutes, separate all-hours consent and final local-save confirmation. Declining reference, all-hours consent or save retains the prior in-memory policy. Invalid saved reference is rejected before prompts with the fixed recovery hint.
2. Authorized grid threshold/duration/recovery menus: preview → Cancel or Confirm. Old menus reject at their original expiry. A separate synthetic battery preference is retained to check rollback preparation.
3. Reserve setup: incomplete input chooses nothing; Cancel preserves preferences; Confirm accepts complete explicit all-hours values. The illustrative 13% / 15% / five-minute answers are synthetic, not this owner's submitted policy. The owner has selected only the 13% warning point.
4. Five virtual scheduled observations produce one reserve warning, one grid warning and one measured below-re-arm recovery notice. The script prints their actual synthetic message text, retaining unknown/manual EV evidence and no equipment control.
5. Both status views reuse the cache without provider refresh or monitor mutation. The brief response retains its complete length bound.
6. Grid/recovery/reserve opt-out and current-code cleanup during provider cooldown use one monitor checkpoint with zero provider calls and preserve core latches. An additional in-memory-only edit removes unsupported override fields while retaining the battery preference, to rehearse private rollback prerequisites. **An older binary is not executed** and no real KV/account is changed.

The last output explains private-secret/CI handoff, cleanup before older rollback, and the remaining manual release, CPU, natural scheduling and receipt checks. No configuration snapshot, credentials, identifiers, raw response or request URL is printed. `/settings reset` restores all deployment preferences; it is not used as an implicit partial reset.

## Observed synthetic request and state counts

| Work | Count |
| --- | --- |
| Authentication | 1 |
| Station reads | 5 |
| Selected-device reads | 5 |
| Telegram replies | 24 |
| Telegram callback acknowledgements | 11 |
| Scheduled notice sends | 3 |
| Weather requests | 0 |
| Cleanup provider calls | 0 |

All 11 Deye and 38 Telegram operations above are intercepted synthetic calls, not network usage. The 24 interactions stay below the existing 48-command cap. This normal journey observes at most one pending event/one send per tick and two monitor checkpoints; the existing runtime tests separately cover saturated two-slot/two-send priority. Cleanup uses one checkpoint, and rollback preparation preserves the synthetic 3 kW battery preference. State counters are bounded with no history. Nothing is added to the deployed Worker graph or its KV/API/CPU paths; this setup-only work does not change the calculated Free-plan ceilings.

## What remains unvalidated

- Hotfix PR #5 still needs owner review and a deliberate manual release, then natural scheduled-cache/status and CPU observations. This feature-branch rehearsal does not incorporate or deploy that separate partial-status fix.
- Grid direction, metering scope, source identity/reference and lower re-arm require independent installation verification. Zero alone cannot establish import direction. The owner's requested grid warning remains 1 kW for ten minutes; no new policy was selected.
- The owner's 13% reserve warning still needs a higher re-arm and persistence duration. Suggested answers are not consent. A fixed warning is not the overnight planner; household baseline/morning-target/margin remain separate inputs.
- Actual Free CPU, cloud scheduling, Telegram receipt and older-binary deployment are not established by local tests or printed previews. Nighttime house-battery use remains for the house by default; report/forecast/notification consent grants no EV exception.

A standalone acceptance test launches outside the checkout with poisoned owner-file/environment sentinels, verifies unchanged files and no sentinel output, and checks synthetic-only output. The library test disables global fetch to catch accidental live access. Temporary test cleanup verifies its resolved directory is a named child of the system temporary directory.
