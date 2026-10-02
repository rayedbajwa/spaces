import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './lib/logger'

const buildLog = log.child({ mod: 'build-web' })

const srcDir = dirname(fileURLToPath(import.meta.url))
const webDir = join(srcDir, 'web')
const publicDir = join(srcDir, '..', 'public')
const screenshotsDir = join(srcDir, '..', 'docs', 'screenshots')

/** Docs screenshots the landing page shows, served from /screenshots/. */
const LANDING_SCREENSHOTS = ['board.png', 'project-page.png', 'agent-output.png', 'generated-spec.png']

export async function ensureFrontendBuilt(): Promise<void> {
  // Production images ship prebuilt assets in a read-only, root-owned public/;
  // rebuilding there fails (and is pointless). Use what was built.
  if (process.env.NODE_ENV === 'production' && (await Bun.file(join(publicDir, 'main.js')).exists())) return
  await mkdir(publicDir, { recursive: true })

  const result = await Bun.build({
    entrypoints: [join(webDir, 'main.tsx')],
    outdir: publicDir,
    format: 'esm',
    target: 'browser',
    sourcemap: 'inline',
    naming: '[name].[ext]',
  })

  if (!result.success) {
    const messages = result.logs.map((log) => log.message).join('\n')
    throw new Error(`Frontend build failed:\n${messages}`)
  }

  await mkdir(join(publicDir, 'screenshots'), { recursive: true })
  for (const name of LANDING_SCREENSHOTS) {
    await copyFile(join(screenshotsDir, name), join(publicDir, 'screenshots', name))
  }
}

if (import.meta.main) {
  await ensureFrontendBuilt()
  buildLog.info('built web assets', { publicDir })
}
