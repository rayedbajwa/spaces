# Security policy

## Reporting a vulnerability

Please **do not** file a public GitHub issue for security vulnerabilities.

Email the maintainers directly with the details. Include:

- A description of the issue and the impact
- Steps to reproduce
- Any relevant logs, PoC code, or screenshots (redact secrets)

We aim to respond within 72 hours. Once a fix is prepared, we'll coordinate a
disclosure timeline with you.

## Known limitations (please read before deploying)

Spaces is designed for **local, single-user development** by default. Some
important caveats:

- **No built-in authentication.** The web UI on `PORT` is open to anyone who
  can reach it. Do **not** expose the port to the internet without putting an
  authenticating reverse proxy (e.g. Caddy with basic-auth, Cloudflare Access,
  Tailscale) in front.
- **OAuth tokens are encrypted at rest** with `ENCRYPTION_KEY` (AES-256-GCM).
  If that key leaks or your Postgres instance is compromised, tokens are only
  as safe as your key management.
- **Agents can execute code** on the host. Pipeline templates give agents the
  authority to run shell commands and modify files in the working directory.
  Do not point Spaces at directories you don't trust it with.
- **Pipeline templates run whatever LLM you configure.** Spaces does not
  sandbox or moderate agent output.

If you plan to deploy Spaces multi-user or publicly, please open an issue —
we're happy to discuss what would be needed (auth, per-user credential vaults,
sandboxed runners) before you go live.
