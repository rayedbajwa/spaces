#!/usr/bin/env bun
/**
 * Browser setup for the agents' Playwright tooling. Idempotent; run by
 * `make setup`, `make up`, the Dockerfile and CI:
 *
 *   1. `playwright install chromium` (adds system deps with --with-deps when
 *      SPACES_BROWSER_DEPS=1, which needs root — used by the Dockerfile).
 *   2. The pi-playwright skill resolves the Playwright CLI relative to its own
 *      package (`node_modules/pi-playwright/node_modules/.bin/playwright-cli`),
 *      while bun hoists that binary to the top-level `node_modules/.bin`; a
 *      symlink bridges the two.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dir, '..')
const withDeps = process.env.SPACES_BROWSER_DEPS === '1'

const args = ['install', ...(withDeps ? ['--with-deps'] : []), 'chromium']
console.log(`[browsers] playwright ${args.join(' ')}`)
execFileSync(path.join(root, 'node_modules', '.bin', 'playwright'), args, { stdio: 'inherit', env: process.env })

// @playwright/cli pins its own (newer) playwright build with its own Chromium
// revision; install that one too so the pi-playwright skill can launch.
const cliPlaywright = path.join(root, 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright', 'cli.js')
if (existsSync(cliPlaywright)) {
  console.log(`[browsers] @playwright/cli's playwright install chromium`)
  execFileSync(process.execPath, [cliPlaywright, 'install', 'chromium'], { stdio: 'inherit', env: process.env })
}

const skillBinDir = path.join(root, 'node_modules', 'pi-playwright', 'node_modules', '.bin')
const skillBin = path.join(skillBinDir, 'playwright-cli')
const hoistedBin = path.join(root, 'node_modules', '.bin', 'playwright-cli')
if (!existsSync(hoistedBin)) {
  console.error('[browsers] @playwright/cli is not installed (node_modules/.bin/playwright-cli missing); run bun install first.')
  process.exit(1)
}
if (!existsSync(skillBin)) {
  mkdirSync(skillBinDir, { recursive: true })
  symlinkSync(path.relative(skillBinDir, hoistedBin), skillBin)
  console.log(`[browsers] linked ${path.relative(root, skillBin)} → ${path.relative(root, hoistedBin)}`)
}
console.log('[browsers] ready: bundled Chromium + pi-playwright skill wrapper')
