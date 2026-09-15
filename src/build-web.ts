import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { log } from './lib/logger'

const buildLog = log.child({ mod: 'build-web' })

const srcDir = dirname(fileURLToPath(import.meta.url))
const webDir = join(srcDir, 'web')
const publicDir = join(srcDir, '..', 'public')

export async function ensureFrontendBuilt(): Promise<void> {
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
}

if (import.meta.main) {
  await ensureFrontendBuilt()
  buildLog.info('built web assets', { publicDir })
}
