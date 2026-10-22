# GitHub tests and Cloudflare delivery

## Continuous integration

[Validation](../.github/workflows/ci.yml) runs on pushes to `main`, pull requests, and manual requests. It is also reusable by the deployment workflow. Ubuntu runners test both Node.js **22 and 24**, using the lockfile with `npm ci`:

1. `npm run check`
2. `npm test`
3. `npm run test:runtime`
4. `npm run test:mock`
5. `npm run build`

Tests use synthetic data and intercepted provider services. The build is a Wrangler deployment **dry run** using the disabled example configuration on a clean checkout. CI receives no Cloudflare, Deye or Telegram credentials. It neither sends real notifications nor establishes live production behavior.

The workflow has read-only repository permissions, pinned action revisions, dependency caching, a 15-minute limit per test job and cancellation of obsolete validation runs. [Dependabot](../.github/dependabot.yml) proposes monthly GitHub Actions updates. To require validation before merging, configure a GitHub ruleset for `main` with both `Checks (Node 22)` and `Checks (Node 24)` status checks after their first successful runs.

## Cloudflare deployment

[Deploy Worker](../.github/workflows/deploy.yml) is **manual**. Select the workflow's **Run workflow** button on `main`. Branches other than `main` are skipped. Both validation jobs must pass before deployment can start; the deploy job checks out the same event revision that was tested. Production deployments are serialized without cancelling a running release.

Complete the initial owner-run setup, KV creation and Deye/Telegram secret upload in [README](../README.md) first. The pipeline updates the Worker in the owner's own account. It does not perform interactive setup or upload Deye/Telegram secrets.

In the repository's **Settings → Environments**, create an environment named **production**, and restrict its deployment branches to `main`. Add these **environment secrets**:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | An owner-created Cloudflare token with deployment permission for the intended account. Start from Cloudflare's Edit Cloudflare Workers token template and review the scope. |
| `CLOUDFLARE_ACCOUNT_ID` | The intended Cloudflare account ID. |
| `WORKER_CONFIG_JSON` | The full JSON contents of the owner's ignored, generated `wrangler.jsonc`, after successful setup and KV configuration. No `.dev.vars`, `.env`, Deye credentials or Telegram credentials. |

These are per-owner settings in the owner's GitHub repository, not a shared deployment service. Keep real identifiers out of Git. Deye/Telegram credentials remain Cloudflare Secrets and are not passed to GitHub jobs. Restrict access to the GitHub environment and its configuration snapshot.

If using the GitHub CLI, secret values can be entered using its prompt. For the configuration snapshot, this PowerShell command reads the ignored file through stdin without putting its value in a command argument or printing it:

```powershell
Get-Content -Raw -LiteralPath wrangler.jsonc | gh secret set WORKER_CONFIG_JSON --env production --repo OWNER/REPO
```

Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` through the GitHub environment UI or CLI prompt. Never paste actual values into documentation, issues, workflow YAML or shell arguments. Merely being signed into Cloudflare on a laptop or through a connector does not provide the GitHub runner with a deployment token.

`WORKER_CONFIG_JSON` is the configuration snapshot applied on every pipeline deployment. **Update it whenever changing local preferences or deployment settings**, otherwise a later release will restore the older saved values. Keep the existing Worker name, account and STATE namespace unless intentionally migrating. Existing alert state is retained in that namespace; measurement/threshold changes still have the cycle-reset semantics documented in the architecture.

The adapter accepts the generated monitor configuration, one existing `STATE` binding, the repository's Worker entry point/compatibility date, disabled public URLs/observability and the five-minute Cron. Extra settings/credential fields, disabled or unconfirmed monitoring, mismatched account IDs and placeholder namespace IDs are rejected before deployment. A compatibility-date change in the repository also requires updating the configuration snapshot. A new custom Wrangler feature needs explicit adapter support and tests.

Only the deployment step receives the three GitHub secrets. The adapter writes the validated config to an ignored file, invokes the installed lockfile version of Wrangler once, and removes the file afterward. It captures Wrangler stdout/stderr because even normal output can contain installation bindings. Public logs contain only a completion message or a fixed error code, not upstream responses/configuration. The deployment command is bounded by a two-minute timeout inside a ten-minute job. On failure, diagnose locally in a private terminal using the owner's setup; do not post raw deployment logs/configuration. If a release timed out, check Cloudflare's deployment history before retrying because the remote outcome may be uncertain.

The pipeline does not create a KV namespace, rotate provider secrets, manipulate alert state, issue equipment commands, call a live test notification, or measure production CPU. Verify subsequent natural Cron readings and account metrics separately. Do not run a second production monitor against the same chat/namespace to test deployment.

## Validation and evidence

See [validation record](VALIDATION.md) for locally tested commands, the observed failing acceptance tests and any hosted GitHub run results. Workflow syntax validation and local runtime tests do not establish that a real Cloudflare deployment has succeeded. Production deployment requires the owner-specific environment secrets above.

## Official references

- [GitHub deployment environments and concurrency](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments)
- [Cloudflare Workers with GitHub Actions](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)
- [Cloudflare Worker Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)
