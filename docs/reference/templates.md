# Pipeline templates

Templates live in `data/pipelines/*.yml` (project-level overrides are
supported). Pick one per kind of work.

| Template | Stages | Use it for |
|---|---|---|
| `aidlc-feature` | init → specify → clarify → plan → constitution → tasks → testplan → parallelize → implement → orchestrate → **review** → verify → **deliver** | A full feature with the implementation harness and delivery loop |
| `aidlc-mvp` | init → specify → clarify → plan → tasks → testplan → parallelize → implement → verify | Lean end-to-end delivery without review/deliver loops |
| `aidlc-classic` | init → specify → clarify → plan → tasks → testplan → parallelize → analyze | Design-only: stop before implementation |
| `aidlc-enterprise` | init → specify → clarify → checklist → plan → constitution → tasks → testplan → parallelize → implement → orchestrate → verify | Governance-heavy delivery |
| `aidlc-express` | init → specify → clarify → implement → verify | Small change, fast |
| `aidlc-bugfix` | init → specify → clarify → implement → verify | Fix a specific bug; verify loops back on failure |
| `aidlc-refactor` | init → specify → clarify → plan → implement → verify | Behaviour-preserving refactor |
| `aidlc-infra` | init → specify → clarify → plan → implement → verify | Infrastructure changes |
| `aidlc-security-patch` | init → specify → clarify → checklist → implement → verify | Security fix with a checklist |
| `aidlc-poc` | init → specify → plan → tasks → implement → verify | Proof of concept, no clarify |
| `aidlc-verify-loop` | init → specify → plan → tasks → testplan → implement → verify | Verify-fix loop until green |
| `aidlc-workshop` | init → specify → clarify → plan → tasks → implement → verify | Teaching / demo flow |
| `test-minimal` | init → specify | Smoke test |

## Schema

```yaml
name: aidlc-feature
version: 1
description: >
  Full feature delivery.
steps:
  - id: code-generation          # unique step id (branch targets)
    stage: implement             # one of the stages listed in Pipelines & stages
    phase: construction          # initialization | ideation | inception | construction
    role: developer              # persona from data/personas
    model: anthropic/claude-sonnet-4-5   # optional per-step model
    thinking: medium             # off | minimal | low | medium | high | xhigh | max
    review: true                 # second-agent review harness
    humanGate: true              # pause for approval (autonomous mode auto-approves)
    maxIterations: 4             # cap when this step is a loop target
    onComplete:
      branch:
        - when: "verification_status == 'fail'"   # variables: verification_status,
          goto: code-generation                    # code_review_status, delivery_status, iteration
        - when: "true"
          goto: end
  retry:                          # optional run-level retry policy
    max: 2
    backoffMs: 30000
```

Branch expressions support `<var> == 'literal'`, `<var> != 'literal'`, `true`
and `false`. `goto` names a step id or `end`; loops are capped by the target's
`maxIterations` (default applies otherwise).

## End-to-end test

`bun run e2e [template …]` creates a fixture project per template, waits for
onboarding, enables autonomous + fast mode, starts a run and drives it to
completion, then writes `e2e-report.md`. Environment: `E2E_CONCURRENCY`,
`E2E_TIMEOUT_MIN`, `E2E_MODEL`, `E2E_KEEP=1` (keep projects), `E2E_REPORT`.

The report has each template's tokens (input, cache reads, output) and cost per
stage and the size of every artifact, also written as JSON (`E2E_JSON`,
default `e2e-report.json`). To check that a prompt change saves tokens without
losing stages or artifacts, run the same templates before and after and pass
the first JSON as `E2E_BASELINE`:

```bash
E2E_JSON=before.json bun run e2e aidlc-mvp       # on main
E2E_BASELINE=before.json bun run e2e aidlc-mvp   # on the branch
```
