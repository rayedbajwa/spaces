import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const srcDir = dirname(fileURLToPath(import.meta.url))
const rootDir = join(srcDir, '..', '..')
const orgDir = join(rootDir, 'data', 'org')
const promotionsDir = join(orgDir, 'promotions')

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

  await mkdir(promotionsDir, { recursive: true })
  await writeFile(join(promotionsDir, `${proposal.id}.json`), JSON.stringify(proposal, null, 2))
  return proposal
}

export async function listPromotionProposals(): Promise<PromotionProposal[]> {
  const proposals: PromotionProposal[] = []
  await mkdir(promotionsDir, { recursive: true })
  for (const file of await readdir(promotionsDir)) {
    if (!file.endsWith('.json')) continue
    try {
      const raw = await readFile(join(promotionsDir, file), 'utf8')
      proposals.push(JSON.parse(raw) as PromotionProposal)
    } catch {
      continue
    }
  }
  return proposals.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function decidePromotionProposal(input: {
  proposalId: string
  decision: 'approved' | 'rejected'
  notes?: string
}): Promise<PromotionProposal> {
  await mkdir(promotionsDir, { recursive: true })
  const filePath = join(promotionsDir, `${input.proposalId}.json`)
  const raw = await readFile(filePath, 'utf8')
  const proposal = JSON.parse(raw) as PromotionProposal

  proposal.status = input.decision
  proposal.decidedAt = new Date().toISOString()
  proposal.decisionNotes = input.notes

  if (input.decision === 'approved') {
    const targetPath = join(orgDir, proposal.targetFile)
    const current = await readTextIfExists(targetPath)
    const block = `\n\n## Promoted from ${proposal.projectNamespace}\n\n### ${proposal.title}\n\n${proposal.content.trim()}\n`
    if (!current.includes(proposal.content.trim())) {
      await writeFile(targetPath, `${current.trimEnd()}${block}`)
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
