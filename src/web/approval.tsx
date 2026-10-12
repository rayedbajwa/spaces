import { useCallback, useEffect, useState } from 'react'
import { SignInScreen, useAuth } from './auth'
import { LoadingBlock } from './loading'
import { renderMarkdown } from './markdown'

/**
 * The owner approval link page (011-owner-approval-link).
 *
 * Opened from a Slack DM or email, it shows the same stage summary the gate
 * recorded and offers approve / approve with notes / request changes. The link
 * is personal and single use: a signed-out visitor signs in inline (returning to
 * the same URL), a wrong recipient is refused, and an expired/used/resolved link
 * shows the winning result or a clear notice with a link back to the in-app gate.
 */

interface ApprovalDecisionView {
  outcome: 'approve' | 'approve_with_notes' | 'request_changes'
  feedback: string | null
  decidedBy: string | null
  decidedAt: string
  summary: string | null
}

/** Where the feature stands, so the owner can decide from the link alone. */
interface ApprovalContext {
  feature: { id: string; title: string; scope?: string } | null
  codeReview: 'approved' | 'changes_requested' | null
  verification: 'pass' | 'partial' | 'fail' | 'missing'
  verificationSummary: string | null
  accepted: { by: string; at: string } | null
  tasks: { done: number; total: number } | null
  delivery: 'merged' | 'partial' | 'blocked' | null
  deployment: { target: string; state: string } | null
  report: { file: string; text: string } | null
  onApprove: string
}

interface ApprovalView {
  context?: ApprovalContext
  project: { name: string; code: string | null }
  stage: string
  kind: 'review' | 'clarification'
  summary: string | null
  state: string
  fallback: boolean
  expiresAt?: string | null
  decision?: ApprovalDecisionView
}

const OUTCOME_LABEL: Record<ApprovalDecisionView['outcome'], string> = {
  approve: 'Approved',
  approve_with_notes: 'Approved with notes',
  request_changes: 'Changes requested',
}

const GOOD = new Set(['approved', 'pass', 'merged', 'success'])
const BAD = new Set(['changes_requested', 'fail', 'blocked', 'failed'])

function StatusChip({ label, value, detail }: { label: string; value: string | null | undefined; detail?: string | null }) {
  const v = value ?? 'not run'
  const tone = GOOD.has(v) ? 'completed' : BAD.has(v) ? 'error' : 'pending'
  return (
    <div className="approval-status">
      <span className="approval-status-label">{label}</span>
      <span className={`mini-badge ${tone}`}>{v.replace(/_/g, ' ')}</span>
      {detail && <span className="approval-status-detail">{detail}</span>}
    </div>
  )
}

function ContextPanel({ context }: { context: ApprovalContext }) {
  return (
    <div className="approval-context">
      {context.feature && (
        <p className="approval-feature"><strong>{context.feature.title}</strong> <code>{context.feature.id}</code>{context.feature.scope ? ` · ${context.feature.scope}` : ''}</p>
      )}
      <div className="approval-statuses">
        <StatusChip label="Code review" value={context.codeReview} />
        <StatusChip label="QA" value={context.verification === 'missing' ? null : context.verification} detail={context.accepted ? `accepted by ${context.accepted.by}` : context.verificationSummary} />
        {context.tasks && <StatusChip label="Tasks" value={context.tasks.done >= context.tasks.total ? 'pass' : 'partial'} detail={`${context.tasks.done}/${context.tasks.total} done`} />}
        <StatusChip label="Delivery" value={context.delivery} />
        {context.deployment && <StatusChip label="Deployment" value={context.deployment.state} detail={context.deployment.target} />}
      </div>
      <p className="approval-effect">{context.onApprove}</p>
      {context.report && (
        <details className="approval-report">
          <summary>Full report <code>{context.report.file}</code></summary>
          <div className="markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(context.report.text) }} />
        </details>
      )}
    </div>
  )
}

function tokenFromPath(): string {
  const match = /^\/approvals\/([^/]+)/.exec(window.location.pathname)
  return match ? decodeURIComponent(match[1]!) : ''
}

export function ApprovalPage() {
  const token = tokenFromPath()
  const { refresh } = useAuth()
  const [view, setView] = useState<ApprovalView | null>(null)
  const [decision, setDecision] = useState<ApprovalDecisionView | null>(null)
  const [error, setError] = useState<{ message: string; code?: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [signIn, setSignIn] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(token)}`)
      const data = (await res.json().catch(() => ({}))) as ApprovalView & { error?: string; code?: string }
      if (res.status === 401) { setSignIn(true); return }
      if (!res.ok) { setError({ message: data.error ?? 'This approval could not be loaded.', code: data.code }); return }
      setSignIn(false)
      setView(data)
      setDecision(data.decision ?? null)
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) })
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => { void load() }, [load])

  async function decide(outcome: ApprovalDecisionView['outcome']) {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/approvals/${encodeURIComponent(token)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome, feedback: feedback.trim() || undefined }),
      })
      const data = (await res.json().catch(() => ({}))) as { decision?: ApprovalDecisionView; error?: string; code?: string }
      if (res.status === 401) { setSignIn(true); return }
      if (!res.ok) {
        if (data.decision) setDecision(data.decision)
        setError({ message: data.error ?? 'The decision could not be recorded.', code: data.code })
        return
      }
      if (data.decision) { setDecision(data.decision); setView((current) => current ? { ...current, state: 'decided' } : current) }
    } catch (e) {
      setError({ message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const projectLink = view?.project.code ? `/spaces/${encodeURIComponent(view.project.code)}` : '/'

  if (loading) {
    return (
      <div className="auth-screen"><div className="auth-card card"><LoadingBlock label="Loading approval…" /></div></div>
    )
  }

  if (signIn) {
    return <SignInScreen needsBootstrap={false} githubLogin={false} openRegistration={false} initialMode="login" onSignedIn={async () => { await refresh(); await load() }} />
  }

  const canDecide = !decision && view?.state !== 'expired' && view?.state !== 'invalidated' && view?.state !== 'undecidable'
  const needsFeedback = (outcome: ApprovalDecisionView['outcome']) => outcome !== 'approve'

  return (
    <div className="approval-screen">
      <div className="approval-card card">
        <p className="eyebrow">Owner approval</p>
        <h1>{view?.project.name ?? 'Approval'}</h1>
        <p className="approval-meta">
          <strong>{view?.kind === 'review' ? 'Approval review' : 'Agent question'}</strong> · stage <code>{view?.stage}</code>
          {view?.fallback ? ' · Owner fallback' : ''}
        </p>

        {error && error.code !== 'already_decided' && <p className="error-text">{error.message}</p>}

        {decision ? (
          <div className="approval-decided">
            <p className="approval-outcome">✅ {OUTCOME_LABEL[decision.outcome]}</p>
            {decision.feedback && <blockquote className="approval-summary">{decision.feedback}</blockquote>}
            <p className="panel-subtitle">Recorded by {decision.decidedBy ?? 'the recipient'} on {new Date(decision.decidedAt).toLocaleString()}.</p>
            {error?.code === 'already_decided' && <p className="panel-subtitle">This gate was already decided; the winning result is shown above.</p>}
          </div>
        ) : view?.state === 'expired' ? (
          <p className="approval-notice">This approval link has expired. Open the gate in Spaces to decide there.</p>
        ) : view?.state === 'invalidated' ? (
          <p className="approval-notice">This gate was resolved elsewhere, so this link is no longer active. Open the project to see the result.</p>
        ) : view && !canDecide ? (
          <p className="approval-notice">This gate is no longer waiting for a decision. Open the project to see the result.</p>
        ) : view ? (
          <>
            {view.summary && <div className="approval-summary markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(view.summary) }} />}
            {view.context && <ContextPanel context={view.context} />}
            <label className="approval-feedback">
              Notes or feedback
              <textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Optional for approve; required for the other two." rows={4} />
            </label>
            <div className="approval-actions">
              <button className="primary-button" disabled={busy} onClick={() => void decide('approve')}>Approve</button>
              <button className="secondary-button" disabled={busy || !feedback.trim()} onClick={() => void decide('approve_with_notes')}>Approve with notes</button>
              <button className="secondary-button danger" disabled={busy || !feedback.trim()} onClick={() => void decide('request_changes')}>Request changes</button>
            </div>
            {error && error.code === 'feedback_required' && <p className="error-text">{error.message}</p>}
          </>
        ) : (
          <p className="approval-notice">This approval link is not valid. Ask for a new request or decide in Spaces.</p>
        )}

        <p className="panel-subtitle approval-back">
          <a href={projectLink}>Open the project in Spaces →</a>
        </p>
        {view?.expiresAt && !decision && <p className="panel-subtitle">This link expires {new Date(view.expiresAt).toLocaleString()}.</p>}
      </div>
    </div>
  )
}
