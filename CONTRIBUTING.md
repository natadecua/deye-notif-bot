# Contributing

Use Node.js 22.13+ and `npm ci`. Before proposing a change, run:

```sh
npm run check
npm test
npm run test:runtime
npm run test:mock
npm run build
```

CI runs these local checks without credentials. Runtime tests intercept every external request. They do not validate live integrations, KV's distributed consistency, or the production Free CPU budget. Keep mock data explicitly synthetic and preserve that distinction in test reports.

Changes to transitions should test cycles and failures rather than mirror implementation. Cover timestamp identity, strict threshold boundaries, long gaps, partial/invalid measurements, retries and persistence ordering. Maintain the KV write-spacing and daily budget. Describe the problem, resulting behavior and meaningful validation in pull requests.

Do not commit `.dev.vars`, `.env`, generated `wrangler.jsonc`, real tokens, station identifiers, chat contents, live fixtures, secret-bearing URLs, account details or unsanitized logs. Use reserved domains and invented values for fixtures. Report vulnerabilities privately as described in SECURITY.md.

Keep the runtime small and dependency-free. Any new API mapping needs published schema evidence, explicit unit/direction/time handling, and an honest statement of whether live testing occurred. Preserve the notification-only scope; charger and inverter control are outside this project. Do not add a central service that collects users' credentials.

Contributions are provided under the repository's MIT license. This is an independent project and does not imply endorsement by Deye, Telegram or Cloudflare.
