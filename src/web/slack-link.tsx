import { useCallback, useEffect, useState } from 'react'
import { json, navigate, useAuth } from './auth'
import { LoadingBlock } from './loading'
import { PageHead } from './shell'

/**
 * Slack identity verification page (012-inbound-outbound-slack, US3).
 *
 * Opened from a one-time Slack DM, it confirms the signed-in person's Slack
 * identity with Spaces. A wrong recipient is refused; a used link shows the
 * verified state. A link grants no role — gate authority is re-checked later.
 */

function tokenFromPath(): string {
  const match = /^\/slack-link\/([^/]+)/.exec(window.location.pathname)
  return match ? decodeURIComponent(match[1]!) : ''
}

export function SlackLinkPage() {
  const token = tokenFromPath()
  const { refresh } = useAuth()
  const [state, setState] = useState<'loading' | 'pending' | 'verified' | 'error'>('loading')
  const [member, setMember] = useState<{ userId: string | null; email: string | null } | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setState('loading')
    try {
      const data = await json<{ state: string; member: { userId: string | null; email: string | null } | null }>(`/api/slack/identity/${encodeURIComponent(token)}`)
      setMember(data.member)
      setState(data.state === 'verified' ? 'verified' : 'pending')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
      setState('error')
    }
  }, [token])
  useEffect(() => { void load() }, [load])

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      await json(`/api/slack/identity/${encodeURIComponent(token)}/confirm`, { method: 'POST', body: '{}' })
      await refresh()
      setState('verified')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead title="Verify your Slack identity" subtitle="Link your Slack account to your Spaces user so you can file and decide from Slack." />
      <section className="panel card">
        {state === 'loading' && <LoadingBlock label="Checking your link…" />}
        {state === 'pending' && (
          <>
            <p>Confirm that this Slack account belongs to you{member?.email ? ` (${member.email})` : ''}. A link grants no project role; it only lets you act as yourself in Slack.</p>
            <button type="button" className="primary-button" disabled={busy} onClick={() => void confirm()}>Verify my identity</button>
          </>
        )}
        {state === 'verified' && <p className="muted">Your Slack identity is verified. You can now file requests and decide gates from Slack.</p>}
        {state === 'error' && <p className="muted">{message ?? 'This verification link is invalid or has expired.'}</p>}
        {message && state !== 'error' && <div className="toast" role="status"><span>{message}</span></div>}
        <p className="intake-back"><button type="button" className="link-button" onClick={() => navigate('/')}>← Back to Spaces</button></p>
      </section>
    </>
  )
}
