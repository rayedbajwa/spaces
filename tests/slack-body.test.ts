import { describe, expect, test } from 'bun:test'
import { parseSlackBody } from '../src/lib/slack-interactions'

const FORM = 'application/x-www-form-urlencoded'

describe('parseSlackBody', () => {
  test('a button click arrives as a form with the JSON in payload', () => {
    const click = { type: 'block_actions', user: { id: 'U1' }, team: { id: 'T1' }, actions: [{ action_id: 'approve', value: 'gate-1' }] }
    const body = new URLSearchParams({ payload: JSON.stringify(click) }).toString()
    expect(parseSlackBody(body, FORM)).toEqual(click)
    expect(parseSlackBody(body, `${FORM}; charset=utf-8`)?.actions?.[0]?.action_id).toBe('approve')
  })

  test('a slash command arrives as plain form fields', () => {
    const body = new URLSearchParams({ command: '/spaces', text: 'add dark mode', user_id: 'U1', team_id: 'T1', trigger_id: '1.2' }).toString()
    expect(parseSlackBody(body, FORM)).toMatchObject({ command: '/spaces', text: 'add dark mode', user_id: 'U1', team_id: 'T1' })
  })

  test('an event arrives as JSON', () => {
    expect(parseSlackBody('{"type":"url_verification","challenge":"abc"}', 'application/json')).toEqual({ type: 'url_verification', challenge: 'abc' })
  })

  test('malformed bodies are undefined', () => {
    expect(parseSlackBody('payload=%7Bnot-json', FORM)).toBeUndefined()
    expect(parseSlackBody('not json', 'application/json')).toBeUndefined()
  })
})
