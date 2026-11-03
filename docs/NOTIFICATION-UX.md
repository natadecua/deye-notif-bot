# Telegram notification UX

Historical draft recovered from the original checkout on 2026-11-03. The dated research/proposals below describe 2026-10-22, not current support or new live validation. Current implementation and verification gates take precedence: [improvement loop](IMPROVEMENT-LOOP.md), [grid import](GRID-IMPORT.md), [measured context](MEASURED-CONTEXT.md), [reserve policy](RESERVE-ALERTS.md), [Telegram commands](TELEGRAM-BOT.md) and [validation](VALIDATION.md). Readable local/kW status, authorized commands and default-off health/recap/quiet/grid preparation have since progressed; grid remains inactive pending installation evidence.

## Implemented formatting (2026-10-22)

Synthetic example:

```text
🔋 House battery full

Charge: 100%

Reading: 22 Oct 2026, 08:24:07 UTC
Deye Cloud data may be delayed.
```

Full thresholds below 100% say “House battery charge target reached” and show both measured charge and configured target. Discharge alerts show measured watts, charge and the two-reading confirmation on separate lines, followed by conditional EV advice. Electrical/profile constraints and the distinction between nominal estimates and actual measurements remain visible. Telegram still receives plain text, with no Markdown/HTML escaping requirements.

The formatting uses the source reading time, explicitly in UTC. It adds no runtime dependency, request, KV read/write or state field. Hysteresis, fresh-reading confirmation and bounded retry behavior are unchanged. Production CPU still needs live measurement.

## Proposed improvements, in priority order

These are ideas, not implemented features. Each behavior change needs tests first.

1. **Installation timezone and data age.** Confirm an IANA timezone in setup/preferences, then show local date/time plus an explicit zone/offset. Show age calculated at the send attempt, including retries, while retaining the original reading time. Never infer the installation timezone from the chat or laptop. Display settings must preserve alert cycles. Exercise day/year boundaries, DST and the Workers runtime; measure CPU before choosing locale-heavy formatting.
2. **Optional installation nickname.** An owner-entered label such as “Home battery” helps distinguish several monitors in one chat. Keep it short, reject control characters, and never derive it from station IDs or expose account identifiers. No extra requests or KV operations are needed when it lives in config.
3. **Compact and detailed messages.** Let the owner choose shorter discharge advice. Keep the measured reading, timestamp, conditional EV wording and any electrical constraints essential to the advice. Put supported charging profiles on separate lines so users can scan them. Do not claim a recommended profile without enough measured context.
4. **Read-only Telegram shortcuts.** A status/settings view could expose current rules and notification switches, with an explicit saved response. Require owner/chat authorization and budget update polling or webhook authentication before implementation. The current v1 transport only sends notifications; it has no settings menu or equipment controls.
5. **Data-health and recovery notices.** Send one bounded notice after persistent stale/unavailable telemetry, then one recovery notice when fresh data returns. Reuse scheduled runs and cap delivery/state writes within the documented budget. Describe Deye data availability only; missing cloud data does not establish a power outage. The Worker cannot reliably report its own complete outage.
6. **Quiet hours and an optional daily recap.** Use the confirmed installation timezone, clearly show what is muted, expire stale pending advice and avoid catch-up floods. Default off. Define bounded aggregation and a KV/CPU budget before adding history; never promise exactly-once delivery.

Start with timezone/data age and a nickname: both improve everyday readability without requiring a new service or interactive command channel. Existing delivery limitations remain in [architecture notes](ARCHITECTURE.md); broader onboarding ideas are in [the PRD](PRD.md).
