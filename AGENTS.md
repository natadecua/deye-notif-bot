# Project instructions

This is a zero-cost, notification-only Deye Cloud monitor for a user's own Cloudflare Workers Free account. Keep Telegram as the v1 delivery channel. Never add inverter/charger control or infer that the EV caused house battery discharge. No central service may collect installation owners' Deye credentials.

Use test-driven development for behavior changes:

1. Add a meaningful test for the requested behavior or a reproduced defect.
2. Run it and verify the expected behavioral failure before changing implementation.
3. Implement the smallest useful change, rerun the test, then run the relevant suite.
4. Record what was locally/mock tested versus live tested. Never label a pre-existing implementation test-first without evidence.

Documentation-only changes do not require behavior tests. Keep the runtime dependency-free and stay within the documented KV/CPU budget. Count distinct fresh readings, preserve hysteresis and bound retries. KV is eventually consistent; do not claim exactly-once delivery.

Keep `.dev.vars`, `.env`, generated `wrangler.jsonc` and all actual credentials/identifiers out of Git. Fixtures must be labelled synthetic. Never log upstream bodies, fetch exceptions or secret-bearing request URLs.

Before publishing code changes, run `npm run check`, `npm test`, `npm run test:runtime` and `npm run build`. Read README.md, docs/ARCHITECTURE.md and docs/VALIDATION.md for setup and failure semantics. No real Deye/Telegram/Cloudflare deployment has been tested unless a later validation record explicitly establishes it.
