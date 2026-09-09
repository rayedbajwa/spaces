# pi-speckit-pdlc

A separate Bun project that uses the Pi SDK to run a Spec Kit-powered PDLC flow.

## Included

- Git repository initialized on `main`
- TypeScript CLI
- tiny Node/Bun server for the web app and API
- React frontend
- live streaming run output in the browser through Server-Sent Events
- review harness plus human-in-the-loop gates after `specify`, `plan`, `tasks`, and `implement`

## Project layout

- `src/cli.ts` — terminal entrypoint
- `src/lib/pdlc.ts` — shared PDLC flow logic
- `src/server.ts` — API + static server
- `src/build-web.ts` — bundles the React frontend with esbuild
- `src/web/index.html` — HTML shell
- `src/web/main.tsx` — React UI
- `src/web/styles.css` — frontend styling

## Install

```bash
bun install
```

Node fallback:

```bash
npm install
```

The app uses the same auth resolution as `pi`, so make sure your Pi credentials or provider env vars are already configured.

## CLI

```bash
bun run pdlc --feature "Add reusable signing templates"
```

With more stages:

```bash
bun run pdlc \
  --feature "Add reusable signing templates" \
  --with-clarify \
  --with-implement
```

Dry run:

```bash
bun run pdlc --feature "Add reusable signing templates" --dry-run
```

Disable review gates or auto-approve reviews:

```bash
bun run pdlc --feature "Add reusable signing templates" --skip-reviews
bun run pdlc --feature "Add reusable signing templates" --skip-hitl
```

Node fallback:

```bash
npm run pdlc:node -- --help
```

## Review harness and human loop

By default, the flow now does this after key stages:

- run the requested Spec Kit stage
- run an AI review pass against the generated artifacts
- pause for human approval after `specify`, `plan`, `tasks`, and `implement`
- continue only after the reviewer answers `approve`, or apply requested changes and re-run the review gate

This gives you a lightweight approval workflow without leaving the same Pi session.

## Web UI

Start the app:

```bash
bun run web
```

Open:

```text
http://localhost:3000
```

Node fallback:

```bash
npm run web:node
```

The web app supports:

- configuring repo path, feature, constitution, plan context, model, and stages
- toggling the review harness and human-in-loop approvals
- running dry runs
- streaming live PDLC output as the session progresses
- answering clarification prompts inline when the flow pauses
- approving or editing review-gate feedback in the browser

## Scripts

- `bun run pdlc`
- `bun run web`
- `bun run dev`
- `npm run build:web`
- `npm run typecheck`
- `npm run pdlc:node`
- `npm run web:node`

## Notes

- Run the flow from inside a git repository, or pass `--cwd` to one.
- The project reads the shipped Spec Kit skill markdown directly from `@the-agency/pi-spec-kit`.
- Generated frontend assets are written to `public/` and ignored by git.
