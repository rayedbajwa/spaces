/**
 * Interactive Slack gate prompts (012-inbound-outbound-slack, review fixes).
 *
 * When a gate opens, the accountable recipient's DM carries the decision
 * buttons (or the clarification question). The posted message's `channel`/`ts`
 * are recorded here so a later decision — from any surface — can mark the
 * prompt decided, and so a thread reply can be matched back to its gate.
 * Best effort: persistence failures never block approval delivery.
 */

import { randomUUID } from 'node:crypto'
import { getDb } from './db'
import { log } from './logger'

const promptLog = log.child({ mod: 'slack-gate-prompts' })

export interface SlackGatePrompt {
  promptId: string
  orgId: string
  gateId: string
  slackUserId: string | null
  channelId: string
  messageTs: string
  promptKind: 'review' | 'clarification'
  decidedAt: string | null
}

const COLS = `
  prompt_id     AS "promptId",
  org_id        AS "orgId",
  gate_id       AS "gateId",
  slack_user_id AS "slackUserId",
  channel_id    AS "channelId",
  message_ts    AS "messageTs",
  prompt_kind   AS "promptKind",
  decided_at    AS "decidedAt"
`

/** Record a posted prompt so it can be updated or resolved back to its gate. */
export async function saveSlackGatePrompt(input: {
  orgId: string
  gateId: string
  slackUserId?: string | null
  channelId: string
  messageTs: string
  promptKind: 'review' | 'clarification'
}): Promise<SlackGatePrompt | undefined> {
  try {
    const [row] = await getDb()<SlackGatePrompt[]>`
      INSERT INTO slack_gate_prompts (prompt_id, org_id, gate_id, slack_user_id, channel_id, message_ts, prompt_kind)
      VALUES (${randomUUID()}, ${input.orgId}, ${input.gateId}, ${input.slackUserId ?? null}, ${input.channelId}, ${input.messageTs}, ${input.promptKind})
      RETURNING ${getDb().unsafe(COLS)}
    `
    return row
  } catch (error) {
    promptLog.warn('could not record a Slack gate prompt', { gateId: input.gateId, error: error instanceof Error ? error.message : String(error) })
    return undefined
  }
}

/** The approval message the recipient replied in, matched by channel + thread ts. */
export async function findSlackGatePromptByMessage(orgId: string, channelId: string, messageTs: string): Promise<SlackGatePrompt | undefined> {
  const [row] = await getDb()<SlackGatePrompt[]>`
    SELECT ${getDb().unsafe(COLS)} FROM slack_gate_prompts
     WHERE org_id = ${orgId} AND channel_id = ${channelId} AND message_ts = ${messageTs} AND decided_at IS NULL
     ORDER BY created_at DESC LIMIT 1
  `
  return row
}

/** Undecided prompts for one person, newest first (a DM reply has no thread ts). */
export async function listOpenSlackGatePromptsForUser(orgId: string, slackUserId: string): Promise<SlackGatePrompt[]> {
  return await getDb()<SlackGatePrompt[]>`
    SELECT ${getDb().unsafe(COLS)} FROM slack_gate_prompts
     WHERE org_id = ${orgId} AND slack_user_id = ${slackUserId} AND decided_at IS NULL
     ORDER BY created_at DESC LIMIT 5
  `.catch(() => [])
}

/** Mark every prompt for a decided gate as decided, and rewrite the message. */
export async function markSlackGatePromptsDecided(gateId: string, text: string): Promise<void> {
  try {
    const prompts = await getDb()<SlackGatePrompt[]>`
      SELECT ${getDb().unsafe(COLS)} FROM slack_gate_prompts WHERE gate_id = ${gateId} AND decided_at IS NULL
    `
    if (prompts.length === 0) return
    const { updateSlackMessage } = await import('./slack')
    for (const prompt of prompts) {
      await updateSlackMessage({
        orgId: prompt.orgId,
        channel: prompt.channelId,
        ts: prompt.messageTs,
        text,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
      }).catch(() => false)
    }
    await getDb()`UPDATE slack_gate_prompts SET decided_at = now() WHERE gate_id = ${gateId} AND decided_at IS NULL`
  } catch (error) {
    promptLog.warn('could not mark Slack gate prompts decided', { gateId, error: error instanceof Error ? error.message : String(error) })
  }
}
