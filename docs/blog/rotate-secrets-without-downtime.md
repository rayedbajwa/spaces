---
title: Your Host Was Breached. Here's How to Rotate Every Secret Without Downtime.
description: When a hosting provider says your environment variables may have been read, every secret has to change. Two of ours couldn't change safely, until we taught the app to accept the old and new value at once.
date: 2026-10-24
image: /screenshots/board.png
---

### When your hosting provider says your environment variables may have been read, every secret has to change. Two of ours couldn't change without breaking production, so we fixed that first.

On October 21 our hosting provider disclosed a security incident: an unauthorized party *may have accessed encrypted environment variables*, and in some cases their decrypted contents. Their advice was blunt and correct: **roll every environment variable that holds a secret, now.**

Most teams read that and think "fine, regenerate the keys." Then they hit the two secrets that can't simply be swapped.

This post is about those two, and the small pattern that makes rotating them boring.

---

## The easy ones

Most secrets are references to someone else's system. You rotate them at the source and paste the new value in:

- **The database password.** Regenerate it at the database; services that reference the connection string pick up the new one on their next deploy.
- **OAuth client secrets** (GitHub sign-in, Slack, Jira, Linear). Generate a new secret in the provider's app settings.
- **API keys for observability and AI providers.** Create a new key, delete the old one.
- **Platform tokens.** In our case the provider had already invalidated every API token issued before the incident, which is how we first noticed: our project workers stopped updating with *"Railway refused the provisioning token"*. A new workspace token fixed it.

Annoying, but each is a five-minute job.

## The two that break things

**1. The encryption key.** Spaces stores secrets on behalf of its users (their model provider keys, a GitHub App private key, OAuth and Slack secrets, integration tokens), encrypted with AES-256-GCM under one key from the environment. Change that key and *every stored secret becomes unreadable at once.* Every organization's integrations stop working until someone re-enters everything.

**2. The internal token.** Our web service talks to a worker per project, authenticated with a shared token. Change it on the web service and every worker that hasn't redeployed yet is suddenly a stranger. And they don't all redeploy at the same moment: each worker updates when it's idle, and during an incident, deploys queue.

In both cases, the problem isn't the new value. It's the window where some things have the new value and some still have the old.

---

## The pattern: accept two values for a while

The fix for both is the same idea: **during a rotation, accept the current value and the previous one.**

For the encryption key:

```ts
// Seal with the current key; open with the current key or, during a rotation, the previous one.
function getKeys(): Buffer[] {
  const previous = process.env.ENCRYPTION_KEY_PREVIOUS?.trim()
  return previous && previous !== process.env.ENCRYPTION_KEY
    ? [derive(process.env.ENCRYPTION_KEY!), derive(previous)]
    : [derive(process.env.ENCRYPTION_KEY!)]
}

export function decryptSecret(ciphertext: string): string {
  const keys = getKeys()
  for (let i = 0; i < keys.length; i += 1) {
    try { return decryptWith(keys[i], ciphertext) } catch (e) { if (i === keys.length - 1) throw e }
  }
}
```

New values are always sealed with the new key. Old values still open. Nothing breaks.

For the internal token, the receiving side accepts either value (with a constant-time comparison), and the sending side always sends the new one:

```ts
export function hasInternalToken(req: Request): boolean {
  const given = req.headers.get('x-spaces-internal') ?? ''
  const accepted = [process.env.SPACES_INTERNAL_TOKEN, process.env.SPACES_INTERNAL_TOKEN_PREVIOUS].filter(Boolean)
  return accepted.some((expected) => sameToken(expected, given))
}
```

Workers read both variables by reference from the web service, so whichever order things redeploy in, every pair of services shares at least one token.

## Then re-seal everything, in one transaction

Accepting two keys only buys time. To finish, every stored secret has to be re-sealed under the new key, so the old one can be retired.

We wrote one script for it. It walks every place a secret is stored (provider keys, OAuth app secrets and the sealed fields inside their config, integration credentials, per-run vaults), opens each value with whichever key works, and seals it again with the new key. Three rules made it safe to run against production:

1. **One transaction.** Either every value is re-sealed or none is.
2. **A dry run that does all the work and rolls back,** so its counts are exact: how many values, how many already current, how many to re-seal.
3. **Abort if anything opens with neither key.** A value nobody can read is a bug to look at, not something to silently skip.

One bug the tests caught before production: writing a JSON column back with `JSON.stringify(value)` and a `::jsonb` cast let the database driver encode the string a second time, turning an object into a JSON string. Casting through text (`$1::text::jsonb`) fixed it, and the test now checks the column is still an object afterwards.

## The runbook

1. Ship the code that accepts two values (it's harmless on its own).
2. Set `ENCRYPTION_KEY_PREVIOUS` to the old key and `ENCRYPTION_KEY` to a new random one; do the same for the internal token. Redeploy.
3. Run the re-seal script: dry run, then apply.
4. When every service runs the new values, delete the `_PREVIOUS` variables.
5. Separately, **rotate at each provider** every secret the old key protected. Re-sealing protects the future; if the old key leaked, the old values must be assumed exposed.

---

## The lesson

Every system has a few secrets that are load-bearing in a way rotation guides don't mention: keys that encrypt other secrets, tokens shared between services that deploy independently. Find them *before* an incident, and give each one a "previous" slot. Then the next disclosure email is an afternoon of routine work instead of an outage.

*Spaces is an AI software factory: specs go in, reviewed and tested pull requests come out. It's [on GitHub](https://github.com/rayedbajwa/spaces), source-available and free for personal use.*
