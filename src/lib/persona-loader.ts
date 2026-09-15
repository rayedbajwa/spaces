import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PIPELINE_ROLES, type PipelineRole } from './pipeline-template'

const srcDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(srcDir, '..', '..')
const personasDir = join(rootDir, 'data', 'personas')

const cache = new Map<PipelineRole, string>()

export async function loadPersona(role: PipelineRole): Promise<string | undefined> {
  const cached = cache.get(role)
  if (cached !== undefined) return cached || undefined
  try {
    const content = await readFile(join(personasDir, `${role}.md`), 'utf8')
    cache.set(role, content)
    return content
  } catch {
    cache.set(role, '')
    return undefined
  }
}

export async function listPersonas(): Promise<Array<{ role: PipelineRole; content: string }>> {
  const out: Array<{ role: PipelineRole; content: string }> = []
  for (const role of PIPELINE_ROLES) {
    const content = await loadPersona(role)
    if (content) out.push({ role, content })
  }
  return out
}
