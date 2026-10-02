# Data guardrails

Secrets and personal data are kept away from AI models. Before anything
reaches a provider, each value is swapped for a stable token; the model works
with the tokens, and the real value is put back only where an agent needs it.

![Data guardrails settings](../screenshots/guardrails.png)

## What is detected

| Kind | Examples |
|---|---|
| **Secrets** | API keys and tokens (GitHub, OpenAI/OpenRouter/Anthropic, Slack, AWS), JWTs, private key blocks, passwords in connection strings of any scheme (`postgres://user:<pw>@…`, `redis://:<pw>@…`), secret query parameters, `NAME=value` where the name says it is secret (`*_TOKEN`, `*_SECRET`, `*PASSWORD*`, `*_KEY`, `PASS`, `PWD`, `CREDENTIALS`, `AUTH`), `password: …` in YAML/JSON |
| **Personal data** | email addresses, phone numbers, SSNs, card numbers (Luhn-checked), IBANs (checksum-checked) |

Code stays readable: `password = req.body.password` or `token: string` is not
a secret; `BYPASS` or `author` is not a secret name; git remotes, no-reply
addresses, versions, dates and UUIDs are not personal data.

## How it works

- **Tokens.** Each value becomes `<EMAIL_1>`, `<PHONE_2>`, `<SECRET_3>` and so
  on, the same token for the same value throughout a run.
- **Every request is masked.** The system prompt (project context files
  included), each stage prompt and shared context, every tool result (file
  reads, command output) and the history are masked. Tool results and prompts
  are masked as they enter the history, so compaction summaries and resumed
  sessions never see real values either.
- **Real values only where they are needed.** When the model calls a tool that
  stays on the machine (the shell and the file tools: `bash`, `read`, `write`,
  `edit`, `grep`, `find`, `ls`), the tokens in its arguments are replaced with
  the real values, so the file it writes or the command it runs still works:
  `export DATABASE_URL=<SECRET_1>` runs with the real URL, and the provider
  never sees it. Tools that send their arguments out of Spaces (web fetch and
  search, the browser, knowledge and integration tools, Slack) keep the tokens.
- **Secret files.** Everything read from `.env*` (not `.example`/`.sample`/
  `.template`), private keys, `.pgpass`, `.npmrc`, `.netrc`,
  `.git-credentials`, `credentials*` and `*secret(s).*` is treated as secret, in
  `NAME=value`, INI, YAML, JSON and `.pgpass` layouts. Source files such as
  `secrets.ts` are code, not secret files.
- **Resumed runs** keep their tokens: each run's vault is stored sealed with
  `ENCRYPTION_KEY` (`run_guard_vaults`). A vault that cannot be read stops the
  resumed run rather than leaving tokens unmapped.
- **Assistant replies** show your own personal data back to you; secrets stay
  tokens.

## What leaves Spaces

In **Mask** and **Strict**, these are masked one way (`[email]`, `[redacted]`)
whatever an agent wrote:

- run logs, a whole line at a time so a value split across streamed chunks is
  still caught;
- Slack posts;
- pull request titles, bodies and review/verification comments;
- stage handoff summaries;
- knowledge-base embeddings (documents and queries alike).

In **Warn** and **Off** they are sent as written, except that **secrets** are
always masked in run logs, pull request bodies and comments, handoff summaries
and embeddings, whatever the setting. Personal data is left as it is in those
two modes.

## Settings

**Organization → Data guardrails** (owners and admins change it):

| Mode | Behaviour |
|---|---|
| **Mask** (default) | Everything above |
| **Strict** | Mask, and agents may not read secret files or print the environment (`printenv`, `env` alone, `export -p`, `declare -x`, `/proc/*/environ`); they refer to variables by name instead. `env NAME=value command` is allowed |
| **Warn** | Nothing is changed; each stage's log counts what was sent |
| **Off** | No guardrails (secrets are still masked in run logs) |

**Never mask** takes exact values or `/patterns/` (for example a public support
address); allowlisted values stay, in secret files too.

Each stage's log says what was kept from the model, for example
`[guardrails] 2 secrets, 1 email kept from the model; 1 tool call blocked`.

The setting is `GET/PUT /api/org/guardrails` (see the [HTTP API](../reference/api.md)).

## Separately: agents never see Spaces' own secrets

Independent of the guardrails, an agent's shell does not carry the
application's own `DATABASE_URL` (or its variants), `PG*`, `ENCRYPTION_KEY`,
`SESSION_SECRET`, Railway tokens or any `*_API_KEY` / `*_SECRET`: they are unset
before every command. A checkout's commands use its own `.env`, which points at
the test database assigned to it. See
[Agents, workers & context](agents-and-workers.md#what-an-agents-machine-offers).
