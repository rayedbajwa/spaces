import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'
import {
  validateTemplate,
  type PipelineTemplate,
  type PipelineTemplateSummary,
} from './pipeline-template'

const srcDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(srcDir, '..', '..')
const orgPipelinesDir = join(rootDir, 'data', 'pipelines')
const projectsDir = join(rootDir, 'data', 'projects')

export interface LoadedTemplate {
  template: PipelineTemplate
  source: 'org' | 'project'
  path: string
}

export async function listTemplates(projectNamespace?: string): Promise<PipelineTemplateSummary[]> {
  const map = await loadAllTemplateMap(projectNamespace)
  return [...map.values()].map(({ template, source }) => ({
    name: template.name,
    version: template.version,
    description: template.description,
    stepCount: template.steps.length,
    source,
  }))
}

export async function getTemplate(name: string, projectNamespace?: string): Promise<LoadedTemplate> {
  const map = await loadAllTemplateMap(projectNamespace)
  const loaded = map.get(name)
  if (!loaded) {
    throw new Error(`Pipeline template "${name}" not found. Available: ${[...map.keys()].join(', ') || '(none)'}`)
  }
  return loaded
}

async function loadAllTemplateMap(projectNamespace?: string): Promise<Map<string, LoadedTemplate>> {
  const map = new Map<string, LoadedTemplate>()

  for (const loaded of await loadFromDir(orgPipelinesDir, 'org')) {
    map.set(loaded.template.name, loaded)
  }

  if (projectNamespace) {
    const projectDir = join(projectsDir, projectNamespace, 'pipelines')
    for (const loaded of await loadFromDir(projectDir, 'project')) {
      map.set(loaded.template.name, loaded)
    }
  }

  return map
}

async function loadFromDir(dir: string, source: 'org' | 'project'): Promise<LoadedTemplate[]> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const loaded: LoadedTemplate[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue
    const path = join(dir, entry)
    try {
      const raw = await readFile(path, 'utf8')
      const parsed = parseYaml(raw)
      const template = validateTemplate(parsed, path)
      loaded.push({ template, source, path })
    } catch (error) {
      throw new Error(`Failed to load pipeline template at ${path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return loaded
}
