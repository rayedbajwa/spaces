import { afterEach, describe, expect, test } from 'bun:test'
import { channelNameFor, renderNotice, slackText } from '../src/lib/slack'

const project = { name: 'Spaces', code: 'DEFA-1', slug: 'spaces-3f701200' }
const savedUrl = process.env.PUBLIC_URL
afterEach(() => { if (savedUrl === undefined) delete process.env.PUBLIC_URL; else process.env.PUBLIC_URL = savedUrl })

function allText(message: { blocks: unknown[] }): string {
  return JSON.stringify(message.blocks)
}

describe('slack channel names', () => {
  test('use the project code, lowercase, within Slack rules', () => {
    expect(channelNameFor({ code: 'DEFA-1', slug: 'x' })).toBe('spaces-defa-1')
    expect(channelNameFor({ code: null, slug: 'My Project!!' })).toBe('spaces-my-project')
    expect(channelNameFor({ code: null, slug: 'a'.repeat(200) }).length).toBe(80)
  })
})

describe('slack messages', () => {
  test('an approval pings the channel, quotes the summary and links to the project', () => {
    process.env.PUBLIC_URL = 'https://spaces.example.com/'
    const message = renderNotice(project, { kind: 'approval_needed', stage: 'review', summary: 'Approved with 2 minor findings.\nTests pass.' })
    expect(message.text).toContain('approval needed on review')
    const text = allText(message)
    expect(text).toContain('<!here>')
    expect(text).toContain('>Approved with 2 minor findings.\\n>Tests pass.')
    expect(text).toContain('https://spaces.example.com/spaces/DEFA-1')
  })

  test('a question carries the agent\'s question; no link without PUBLIC_URL', () => {
    delete process.env.PUBLIC_URL
    const message = renderNotice(project, { kind: 'question', stage: 'clarify', question: 'Which database should the service use?' })
    expect(allText(message)).toContain('Which database should the service use?')
    expect(allText(message)).not.toContain('Open in Spaces')
  })

  test('updates: started, stage finished, finished, failed', () => {
    expect(renderNotice(project, { kind: 'run_started', pipeline: 'adhoc-implement-loop', stages: ['implement', 'review', 'verify'] }).text).toContain('run started')
    expect(allText(renderNotice(project, { kind: 'stage_finished', stage: 'plan', summary: 'Plan written.' }))).toContain('Plan written.')
    expect(renderNotice(project, { kind: 'run_finished' }).text).toContain('run finished')
    expect(allText(renderNotice(project, { kind: 'run_failed', stage: 'verify', message: 'Tests timed out' }))).toContain('Tests timed out')
  })

  test('text is escaped and cut to fit a block', () => {
    expect(slackText('a < b & c > d')).toBe('a &lt; b &amp; c &gt; d')
    expect(slackText('x'.repeat(5000), 100).length).toBe(100)
    // An agent summary cannot ping everyone or inject links.
    expect(allText(renderNotice(project, { kind: 'stage_finished', stage: 'plan', summary: '<!channel> <https://evil|click>' }))).not.toContain('<!channel>')
    // The notification text is mrkdwn too: a project named <!channel> must not ping anyone.
    const named = renderNotice({ name: '<!channel>', code: null, slug: 'x' }, { kind: 'approval_needed', stage: '<!everyone>' })
    expect(named.text).not.toContain('<!channel>')
    expect(named.text).not.toContain('<!everyone>')
  })
})
