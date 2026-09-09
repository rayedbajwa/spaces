import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const srcDir = dirname(fileURLToPath(import.meta.url))
const webDir = join(srcDir, 'web')
const publicDir = join(srcDir, '..', 'public')

export async function ensureFrontendBuilt(): Promise<void> {
  await mkdir(publicDir, { recursive: true })

  await build({
    entryPoints: {
      app: join(webDir, 'main.tsx'),
    },
    outdir: publicDir,
    bundle: true,
    format: 'esm',
    splitting: false,
    sourcemap: 'inline',
    target: ['es2022'],
    platform: 'browser',
    jsx: 'automatic',
    logLevel: 'silent',
    loader: {
      '.css': 'css',
    },
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await ensureFrontendBuilt()
  console.log(`Built web assets in ${publicDir}`)
}
