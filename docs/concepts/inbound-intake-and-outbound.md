# Inbound Intake and outbound triggers

Spaces is two-way: work can arrive from other tools, and things that happen in
Spaces can trigger actions back in them. Both directions are organization-scoped,
audited and additive — with no configured source, Slack link or subscription the
feature is inert and pipeline, gate and authorization behavior is unchanged.

## Inbound Intake

Every inbound request — a Jira or Linear issue, a Slack message or `/spaces`
request, a Datadog alert — lands in the organization's **Intake** queue as one
normalized item. Items are deduplicated per `(source, external_ref)`: a
re-delivery updates the row and bumps its repeat count instead of creating a
duplicate, so an alert storm aggregates into one item.

- Items are stored masked through the organization's **Data guardrails**, and
  every read and write is filtered by `org_id`. Two organizations never see each
  other's queue.
- The queue is ordered by priority (`urgent`, `high`, `normal`, `low`) and then
  by first arrival. A triager can change priority, dismiss with a reason,
  restore, merge duplicates, or convert an item into project work.
- Conversion starts the existing `specify` stage in the chosen project with
  `feature` or `bugfix` scope and records a durable work link (`intake_work_links`)
  pointing at the run and, once it exists, the intent directory. The board links
  that converted intent back to Intake.
- Updating the source ticket after conversion is **best effort**: a Jira
  comment or Linear comment is attempted, a failure records
  `source_update_state = failed`, and the conversion itself is never rolled back.
- Source health (`intake_sources.last_sync_*`) is shown in the queue. A failed
  connector fetch marks the source unhealthy and stops new arrivals from it,
  while already-queued items stay.

### Routing rules

Enabled routing rules pre-suggest project, team and priority when an item first
arrives. Precedence is higher `priority_order`, then more specific match, then
oldest. Suggestions are advisory: a manual choice overrides them, sets
`rule_overridden`, and is recorded in the item's transition history. A disabled
rule is never evaluated.

### Connectors

| Source | How items arrive |
|---|---|
| Jira | Polled over JQL for the watched project scope, updated since the cursor. |
| Linear | Polled over the watched team, updated since the cursor. |
| Datadog | Polled from `/api/v1/events` by severity and tags; alerts normalize to name, severity, service and link. Connected as a token integration (API key + application key + site), sealed in `app_integrations`. |
| Slack | Pushed from a message shortcut, an `app_mention` or the `/spaces` slash command; attributed to the verified Slack person. |

## The two-way Slack surface

With Slack connected, a person can file a request and decide a gate without
opening Spaces — with the same authority, verbatim feedback and exactly-once
effect as the in-app gate.

1. **Link identity.** A Slack DM or command matches the Slack profile email to
   exactly one active member of the organization. A unique match verifies
   immediately; zero or ambiguous matches create a `pending` link and send a
   one-time verification link the person opens signed in as their Spaces user.
   A Slack identity link grants no project or team role.
2. **File work.** A verified person files an Intake item under the same rules as
   any other source, attributed to them.
3. **Decide a gate.** The interactive prompt's **Approve**, **Approve with
   notes** and **Request changes** buttons map to the same decision core the
   in-app gate and owner approval links use. The decision is inserted once per
   gate (`UNIQUE (gate_id)`); a second or stale action shows the winning outcome
   and changes nothing.
4. **Answer a question.** A clarification thread prompt carries the agent's
   question and an in-app link; the answer is delivered verbatim and the run
   continues.

Slack HTTP endpoints (`/api/slack/{events,interactions,commands}`) authenticate
by signature, never by session: each request verifies `X-Slack-Signature` and a
bounded timestamp window against the organization's sealed signing secret. The
workspace is resolved to an organization only when exactly one matches; a
multi-org workspace fails closed. Refusals and successful links are audited.

## Outbound triggers

Per-organization or per-project **subscriptions** map a notable event to an
action in another tool:

| Event | Fires when |
|---|---|
| `run_failed` | A run ends in error. |
| `gate_opened` | A run pauses for a review or clarification. |
| `stage_completed` | A stage finishes. |
| `verification_completed` | An intent's verification passes or is accepted. |
| `feature_delivered` | A feature's delivery status becomes merged. |

Each matching enabled subscription gets an `outbound_deliveries` row inserted
`ON CONFLICT (subscription_id, event_key) DO NOTHING`, so an event applies at
most once per target. A background drain retries `pending`/`failed` rows with
exponential backoff and a bounded attempt cap.

Actions are reversible: comment or update an issue (Jira, Linear, GitHub),
create an issue (GitHub, Linear), or post a channel message (Slack). Payloads
are masked through the organization's guardrails before they leave the app and
carry no secrets. Emission is fire-and-forget: a target outage retries, and
delivery never changes a run's state.

## API summary

| Route | Purpose |
|---|---|
| `GET` / `PATCH /api/intake` | List the queue / change priority or routing override. |
| `GET` / `PUT /api/intake/sources` | List / configure watched sources. |
| `GET` / `PUT /api/intake/routing-rules` | List / replace routing rules. |
| `POST /api/intake/:id/{convert,dismiss,restore,merge}` | Triage actions. |
| `POST /api/integrations/datadog/{verify,token}` | Verify / connect Datadog. |
| `GET` / `PUT /api/outbound/subscriptions` | List / replace subscriptions. |
| `POST /api/slack/{events,interactions,commands}` | Signature-verified Slack inbound. |
| `GET /api/slack/identity/:token`, `POST /api/slack/identity/:token/confirm` | Open / confirm a Slack identity link. |

All mutating Intake and outbound routes are org-admin gated and `org_id` scoped.
