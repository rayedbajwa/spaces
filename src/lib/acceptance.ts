/**
 * Accepting a feature whose verification did not fully pass.
 *
 * Verification reports PASS, PARTIAL or FAIL, and only PASS used to finish a
 * feature. Real work often ends at PARTIAL — a browser suite that cannot run
 * here, a requirement deferred on purpose — and the person responsible is
 * entitled to say "this is done" and move on. That decision is theirs, not the
 * agent's, so it is recorded as a document beside the verification report: who
 * accepted it, when, against which verification status, and why.
 *
 * Keeping it as a file rather than a database flag matches everything else
 * about a feature's state: it travels with the repository, appears in the pull
 * request, and survives a project being re-cloned.
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { findLatestFeatureDirAbsolute } from './aidlc'
import { log } from './logger'

const acceptLog = log.child({ mod: 'acceptance' })

import { ACCEPTANCE_FILE } from './acceptance-file'
export { ACCEPTANCE_FILE }

export interface Acceptance {
  /** Verification status at the moment it was accepted. */
  verificationStatus: 'pass' | 'partial' | 'fail' | 'missing'
  acceptedBy: string
  acceptedAt: string
  note?: string
}

export function parseAcceptance(markdown: string): Acceptance | undefined {
  const status = /^-\s*Verification status:\s*(pass|partial|fail|missing)/im.exec(markdown)?.[1]?.toLowerCase()
  const by = /^-\s*Accepted by:\s*(.+)$/im.exec(markdown)?.[1]?.trim()
  const at = /^-\s*Accepted at:\s*(.+)$/im.exec(markdown)?.[1]?.trim()
  if (!status || !by || !at) return undefined
  const note = /^##\s*Why\s*$\n+([\s\S]*?)(?:\n##|\s*$)/im.exec(markdown)?.[1]?.trim()
  return {
    verificationStatus: status as Acceptance['verificationStatus'],
    acceptedBy: by,
    acceptedAt: at,
    note: note || undefined,
  }
}

/** The acceptance recorded for a project's latest feature, if any. */
export async function readAcceptance(projectPath: string): Promise<Acceptance | undefined> {
  const featureDir = await findLatestFeatureDirAbsolute(projectPath).catch(() => null)
  if (!featureDir) return undefined
  const markdown = await readFile(path.join(featureDir, ACCEPTANCE_FILE), 'utf8').catch(() => undefined)
  return markdown ? parseAcceptance(markdown) : undefined
}

export function renderAcceptance(acceptance: Acceptance, featureName: string): string {
  return [
    `# Acceptance — ${featureName}`,
    '',
    `This feature was accepted as delivered with verification status **${acceptance.verificationStatus.toUpperCase()}**.`,
    '',
    `- Verification status: ${acceptance.verificationStatus}`,
    `- Accepted by: ${acceptance.acceptedBy}`,
    `- Accepted at: ${acceptance.acceptedAt}`,
    '',
    '## Why',
    '',
    acceptance.note?.trim() || 'No reason given.',
    '',
  ].join('\n')
}

/**
 * Record that a person accepted the feature as it stands. Returns the written
 * record, or undefined when the project has no feature to accept.
 */
export async function recordAcceptance(input: {
  projectPath: string
  verificationStatus: Acceptance['verificationStatus']
  acceptedBy: string
  note?: string
}): Promise<{ acceptance: Acceptance; file: string } | undefined> {
  const featureDir = await findLatestFeatureDirAbsolute(input.projectPath).catch(() => null)
  if (!featureDir) return undefined
  const acceptance: Acceptance = {
    verificationStatus: input.verificationStatus,
    acceptedBy: input.acceptedBy,
    acceptedAt: new Date().toISOString(),
    note: input.note?.trim() || undefined,
  }
  const file = path.join(featureDir, ACCEPTANCE_FILE)
  await writeFile(file, renderAcceptance(acceptance, path.basename(featureDir)))
  acceptLog.info('feature accepted', { featureDir, status: acceptance.verificationStatus, by: acceptance.acceptedBy })
  return { acceptance, file }
}

/** Remove the acceptance, so a feature returns to whatever its verification says. */
export async function withdrawAcceptance(projectPath: string): Promise<boolean> {
  const featureDir = await findLatestFeatureDirAbsolute(projectPath).catch(() => null)
  if (!featureDir) return false
  const { rm } = await import('node:fs/promises')
  const file = path.join(featureDir, ACCEPTANCE_FILE)
  const existed = await readFile(file, 'utf8').then(() => true).catch(() => false)
  if (existed) await rm(file, { force: true })
  return existed
}
