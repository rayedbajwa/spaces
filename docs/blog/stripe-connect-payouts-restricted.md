---
title: "Stripe Connect Payouts Suddenly Failing? cannot_create_connect_standard_payouts_through_api"
description: Every withdrawal in our marketplace app started failing at once, for every user. The cause was a Stripe setting no connected account shows, and the fix was half a click in the Dashboard and half a small piece of code.
date: 2026-11-18
---

### Every withdrawal in our marketplace app failed at once, for every user. Nothing in any connected account explained why.

TaasQ is a small marketplace app: people post jobs, helpers do them, and helpers withdraw their earnings to a bank account through **Stripe Connect**. Withdrawals had worked for months.

Then two different helpers reported the same thing within an hour: *"We could not send your withdrawal. Please try again."*

## The error under the friendly message

Our server logs had the real one:

> It's been a while since you used this payout method on connected accounts, so we have temporarily restricted this capability until you confirm that this is intentional. Log in to the Stripe Dashboard to confirm that you intended to use this payout method on connected accounts, then try your request again.

Code: **`cannot_create_connect_standard_payouts_through_api`**

Three things about this error make it confusing:

1. **It's a platform setting, not an account problem.** Every connected account looked fine: verified, payouts enabled, bank attached. The restriction sits on the *platform*, so it affects every account at once.
2. **It's triggered by inactivity.** The app had gone a while without a payout of that kind, so Stripe paused the payout method until a person confirmed it was intentional.
3. **Nothing tells you ahead of time.** You find out when a real user's withdrawal fails.

## The fix, part 1: confirm in the Dashboard

In the Stripe Dashboard (live mode), there was a task asking to confirm the payout method for connected accounts. Approving it ("View task") lifted the restriction. A $10 test withdrawal went through a few minutes later.

If you're reading this because you just hit the error, that's the whole fix. Check for a pending task or an "inactive features" notice in your live Dashboard.

## The fix, part 2: fail well next time

The restriction can come back, and when it does, the experience shouldn't be every user getting a generic error and retrying. So we added a small pause switch:

```js
/** The Stripe error that means the platform's payouts to connected accounts are restricted. */
export function isPlatformPayoutRestriction(error) {
  const code = String(error?.code || error?.raw?.code || '')
  if (/^cannot_create_connect_\w*payouts/.test(code)) return true
  const message = String(error?.message || error?.raw?.message || '')
  return /temporarily restricted this capability|confirm that this is intentional/i.test(message)
}
```

When a payout fails with it:

- **Record a platform-wide pause** in the database, and log an error that says exactly what a person has to do ("confirm the payout method in the Stripe Dashboard").
- **Turn later withdrawals away before any money moves,** with an honest message: *"Withdrawals are paused for a moment while we confirm a setting with our payment provider. Your balance is safe: nothing was sent or taken."*
- **Let one attempt through every 30 minutes** to see if the restriction was lifted.
- **Clear the pause** on the first successful payout.

The wallet screen reads the same flag, so users see the pause before they try, not after.

## Lessons for anyone running Connect

- **Log Stripe's error code, not just your message.** Our users saw "please try again"; the code told us exactly what was wrong.
- **Some failures belong to the platform.** If an error isn't about one account, treat it as a platform state: stop hammering Stripe and tell users the truth.
- **Inactivity is a failure mode.** A payout path that hasn't run in a while can be switched off without anything changing in your code.
- **Don't let a retry loop hide it.** Users retrying a platform-level failure just generate more failures.

*We found and fixed this while building TaasQ with Spaces, an AI software factory that turns tickets into reviewed, tested pull requests. It's [on GitHub](https://github.com/rayedbajwa/spaces).*
