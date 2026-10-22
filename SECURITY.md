# Security

Deploy into your own Cloudflare account and keep account access restricted. Cloudflare Secrets store deployed credentials; KV also contains a bearer token and should be treated as sensitive. Use a dedicated KV namespace per Worker. Password hashes can authenticate and must be protected like passwords.

Ignored local files are not encrypted. Keep the laptop account and backups secure. The setup script requests mode 600 on its credential file; platform filesystem permissions may differ. Never paste tokens or secret-bearing URLs into public issues, logs, screenshots or chat.

Runtime logs contain fixed event codes only. Do not replace sanitized errors with raw fetch exceptions: Telegram's token is part of the URL path, and Deye's app ID appears in the auth URL query. Persistent Cloudflare observability is disabled in the template. Review any account-level tracing/log export configuration you enable yourself.

If credentials leak, revoke/rotate them with the providers, update local secrets and Cloudflare Secrets, and redeploy as needed. Cached authentication is fingerprinted against the new credentials and will be replaced; also remove `auth:v1` in your namespace if you need to invalidate the stored copy immediately. A remote Deye session may require provider-side revocation independently of local deletion.

For a vulnerability, use the hosting repository's private security advisory feature if enabled, or contact its maintainer privately. This repository has no configured reporting email. Do not open a public issue containing exploitable credential details or real account data.
