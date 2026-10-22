# Related Deye projects

Reviewed **2026-10-22**. These are documentation/source comparisons, not live deployment or security audits. No third-party application was installed or given credentials. Repository visibility alone does not establish an open-source license.

| Project | Runtime and data access | Relationship to this project |
| --- | --- | --- |
| [zeront4e/deye-solarman-telegram-bot](https://github.com/zeront4e/deye-solarman-telegram-bot) | Java 21 + Python, local-network inverter/logger access, persistent service; README describes a Raspberry Pi and systemd | Useful Telegram commands and statistics. Its continuous local process does not meet the no-always-on-home-computer requirement. Apache-2.0 license shown by GitHub. |
| [Artyomushko/deye-svitlobot](https://github.com/Artyomushko/deye-svitlobot) | Deye Cloud; Cloudflare Workers/KV option plus AWS/GCP adapters | Closest small serverless architecture found. MIT licensed. It detects grid presence and pings Svitlobot; it does not document our full-charge/discharge cycles or EV reduction hints. |
| [botnick/deyecloud](https://github.com/botnick/deyecloud) | Deye Cloud; Cloudflare Workers + D1, PWA dashboard and Telegram/Discord delivery | Closest broader public-source product found. Thai UI, forecasting/history and fault/low-SOC alerts. Its inspected alert module implements other alert policies, not our specific full-charge and sustained-discharge behavior. No LICENSE file or package license field was found in the inspected revision; clarify licensing before reusing code. |
| [crustovsky/deyecloud-browser](https://github.com/crustovsky/deyecloud-browser) | Read-only Deye Cloud; five-minute Worker, D1 and web dashboard | MIT licensed dashboard with history and tariff summaries. Telegram battery notifications are not a documented feature. Useful API/units reference, but a larger and different user interface. |
| [DeyeCloudDevelopers/deye-openapi-client-sample-code](https://github.com/DeyeCloudDevelopers/deye-openapi-client-sample-code) | Official REST sample requests | Reference for authentication and endpoints, not a complete notification service. |

Inspected revisions for the closest serverless candidates:

- `Artyomushko/deye-svitlobot`: `35a38287c95e517caac2b8edd17b9e13249e9f56`.
- `botnick/deyecloud`: `134cb5b29d267a1c2bd70937e9d22cdcdef3ff96`, including `README.md`, `package.json`, the repository tree and `src/worker/alerts.ts`.
- `crustovsky/deyecloud-browser`: `a9243a96110b49b5770f32b39938ba9c7b4b377a`.

## Decision

Keep this focused, notification-only Worker for the requested v1. The local Java bot needs a different hosting/data-access architecture, and the cloud projects reviewed do not demonstrate the exact two alert cycles, strict timestamp freshness and confirmed manual EV estimate together. The existing implementation already has local tests for those requirements.

This is a scoped search, not a claim that no other matching project exists. Reassess existing projects before adding a dashboard, history analytics or a larger bot command interface. Do not reuse unlicensed source or bring inverter/charger control into this project.
