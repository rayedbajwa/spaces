import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { getDefaultOrgId } from './orgs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(srcDir, '..', '..')
const orgDir = join(rootDir, 'data', 'org')
const legacyPromotionsDir = join(orgDir, 'promotions')

/** Proposals live per organization; files from before tenancy sit in the legacy directory and belong to the default one. */
function promotionsDirFor(orgId: string): string {
  return join(orgDir, 'promotions', orgId)
}

async function migrateLegacyPromotions(orgId: string, isDefault: boolean): Promise<void> {
  if (!isDefault) return
  const target = promotionsDirFor(orgId)
  await mkdir(target, { recursive: true })
  try {
    for (const file of await readdir(legacyPromotionsDir)) {
      if (!file.endsWith('.json')) continue
      await rename(join(legacyPromotionsDir, file), join(target, file)).catch(() => undefined)
    }
  } catch { /* nothing to migrate */ }
}

export interface PromotionProposal {
  id: string
  projectNamespace: string
  title: string
  content: string
  targetFile: string
  status: 'pending' | 'approved' | 'rejected'
  createdAt: string
  decidedAt?: string
  decisionNotes?: string
}

export async function createPromotionProposal(input: {
  orgId: string
  projectNamespace: string
  title: string
  content: string
  targetFile?: string
}): Promise<PromotionProposal> {
  const proposal: PromotionProposal = {
    id: randomUUID(),
    projectNamespace: input.projectNamespace,
    title: input.title,
    content: input.content,
    targetFile: input.targetFile ?? 'principles.md',
    status: 'pending',
    createdAt: new Date().toISOString(),
  }

  const dir = promotionsDirFor(input.orgId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, `${proposal.id}.json`), JSON.stringify(proposal, null, 2))
  return proposal
}

export async function listPromotionProposals(orgId: string): Promise<PromotionProposal[]> {
  const proposals: PromotionProposal[] = []
  await migrateLegacyPromotions(orgId, orgId === await getDefaultOrgId())
  const dir = promotionsDirFor(orgId)
  await mkdir(dir, { recursive: true })
  for (const file of await readdir(dir)) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await readFile(join(dir, file), 'utf8')
      proposals.push(JSON.parse(raw) as PromotionProposal)
    } catch {
      continue
    }
  }
  return proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function decidePromotionProposal(input: {
  orgId: string
  proposalId: string
  decision: 'approved' | 'rejected'
  notes?: string
}): Promise<PromotionProposal> {
  await migrateLegacyPromotions(input.orgId, input.orgId === await getDefaultOrgId())
  const dir = promotionsDirFor(input.orgId)
  await mkdir(dir, { recursive: true })
  const filePath = join(dir, `${input.proposalId}.json`)
  const raw = await readFile(filePath, 'utf8')
  const proposal = JSON.parse(raw) as PromotionProposal

  proposal.status = input.decision
  proposal.decidedAt = new Date().toISOString()
  proposal.decisionNotes = input.notes

  if (input.decision === 'approved') {
    // Approved learnings land in the organization's memory (per tenant), not in shared files.
    const { getOrgMemory, updateOrgMemory } = await import('./auth')
    const current = (await getOrgMemory(input.orgId)).manualText
    const block = `\n\n## Promoted from ${proposal.projectNamespace}\n\n### ${proposal.title}\n\n${proposal.content.trim()}\n`
    if (!current.includes(proposal.content.trim())) {
      await updateOrgMemory(input.orgId, { manualText: `${current.trimEnd()}${block}` })
    }
  }

  await writeFile(filePath, JSON.stringify(proposal, null, 2))
  return proposal
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}
