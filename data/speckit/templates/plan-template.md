# Implementation Plan: [FEATURE]

**Branch**: `[###-feature-name]` · **Date**: [DATE] · **Spec**: [spec.md](./spec.md)

<!-- Replace every [placeholder]. Facts and decisions only; do not restate the spec. -->

## Summary

[The requirement and the technical approach, in 2–4 sentences.]

## Technical Context

**Language/Version**: [e.g. TypeScript 5.6 on Bun 1.2]
**Primary Dependencies**: [frameworks and libraries]
**Storage**: [e.g. PostgreSQL, files, or N/A]
**Testing**: [test runner and kinds of tests]
**Target Platform**: [e.g. Linux server, browser]
**Project Type**: [library / cli / web-service / web-app / mobile-app …]
**Performance Goals / Constraints / Scale**: [only when they matter; else N/A]

<!-- Mark a real unknown as NEEDS CLARIFICATION and resolve it in research.md. -->

## Constitution Check

<!-- Each relevant principle from .specify/memory/constitution.md: ✅ pass, or ⚠ violation justified under Complexity Tracking. Re-check after design. -->

- [Principle]: [✅ / ⚠ why]

## Project Structure

```text
specs/[###-feature]/   plan.md, research.md, data-model.md, quickstart.md, contracts/, tasks.md
```

```text
[The real directories and files this feature adds or changes]
```

## Complexity Tracking *(only for justified constitution violations)*

| Violation | Why needed | Simpler alternative rejected because |
|-----------|------------|--------------------------------------|
