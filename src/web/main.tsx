import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

type RunStatus = 'running' | 'paused' | 'completed' | 'error'

type RunSnapshot = {
  runId: string
  status: RunStatus
  stage?: string
  pauseKind?: 'clarification' | 'review'
  log: string
  sessionFile?: string
  error?: string
}

type DryRunResponse = {
  status: 'dry-run'
  plan: unknown
}

type CreateRunResponse = RunSnapshot | DryRunResponse | { error: string }

type FormState = {
  cwd: string
  feature: string
  constitution: string
  planContext: string
  stages: string
  model: string
  thinking: string
  withConstitution: boolean
  withClarify: boolean
  withImplement: boolean
  persistSession: boolean
  reviewHarness: boolean
  humanInLoop: boolean
  verbose: boolean
}

const presets: Array<{ label: string; feature: string; planContext: string }> = [
  {
    label: 'Reusable templates',
    feature: 'Add reusable signing templates with saved field layouts and signer roles',
    planContext: 'Use Bun for the CLI, keep artifacts in the target repo, and prefer incremental delivery.',
  },
  {
    label: 'Approval flow',
    feature: 'Add an internal approval step before document signature requests are sent',
    planContext: 'Capture audit history and expose operational status clearly in the generated plan.',
  },
]

const defaultForm: FormState = {
  cwd: '',
  feature: '',
  constitution: '',
  planContext: '',
  stages: '',
  model: '',
  thinking: '',
  withConstitution: false,
  withClarify: false,
  withImplement: false,
  persistSession: false,
  reviewHarness: true,
  humanInLoop: true,
  verbose: false,
}

function App() {
  const [form, setForm] = useState<FormState>(defaultForm)
  const [run, setRun] = useState<RunSnapshot | null>(null)
  const [clarification, setClarification] = useState('')
  const [busy, setBusy] = useState(false)
  const [statusMessage, setStatusMessage] = useState('Ready to start a PDLC flow.')
  const [dryRunOutput, setDryRunOutput] = useState<string>('')
  const eventSourceRef = useRef<EventSource | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close()
    }
  }, [])

  useEffect(() => {
    if (!logRef.current) {
      return
    }
    logRef.current.scrollTop = logRef.current.scrollHeight
  }, [run?.log, dryRunOutput])

  const canAnswer = run?.status === 'paused'
  const runMeta = useMemo(() => {
    if (!run) {
      return 'No active run'
    }

    const parts = [`Run ${run.runId.slice(0, 8)}`]
    if (run.stage) {
      parts.push(`Stage: ${run.stage}`)
    }
    if (run.sessionFile) {
      parts.push(`Session: ${run.sessionFile}`)
    }
    return parts.join(' • ')
  }, [run])

  async function startRun(dryRun: boolean) {
    setBusy(true)
    setClarification('')
    setDryRunOutput('')
    if (!dryRun) {
      disconnectEvents()
      setRun(null)
    }

    try {
      const result = await postJson<CreateRunResponse>('/api/runs', {
        ...form,
        cwd: form.cwd || undefined,
        feature: form.feature || undefined,
        constitution: form.constitution || undefined,
        planContext: form.planContext || undefined,
        stages: form.stages || undefined,
        model: form.model || undefined,
        thinking: form.thinking || undefined,
        reviewHarness: form.reviewHarness,
        humanInLoop: form.humanInLoop,
        dryRun,
      })

      if ('error' in result) {
        setStatusMessage(`Error: ${result.error}`)
        return
      }

      if ('status' in result && result.status === 'dry-run') {
        setStatusMessage('Dry run complete.')
        setDryRunOutput(JSON.stringify(result.plan, null, 2))
        return
      }

      setRun(result)
      setStatusMessage(result.status === 'running' ? 'Flow started.' : `Flow ${result.status}.`)
      connectEvents(result.runId)
    } catch (error) {
      setStatusMessage(`Error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  async function submitAnswer() {
    if (!run || !clarification.trim()) {
      return
    }

    setBusy(true)

    try {
      const response = await postJson<RunSnapshot | { error: string }>(`/api/runs/${run.runId}/answer`, {
        answer: clarification,
      })

      if ('error' in response) {
        setStatusMessage(`Error: ${response.error}`)
        return
      }

      setClarification('')
      setRun(response)
      setStatusMessage(run?.pauseKind === 'review' ? 'Review feedback submitted. Continuing flow...' : 'Clarification submitted. Continuing flow...')
      connectEvents(response.runId)
    } catch (error) {
      setStatusMessage(`Error: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  function connectEvents(runId: string) {
    disconnectEvents()
    const eventSource = new EventSource(`/api/runs/${runId}/events`)
    eventSourceRef.current = eventSource

    eventSource.onmessage = (event) => {
      const next = JSON.parse(event.data) as RunSnapshot
      setRun(next)

      if (next.status === 'paused') {
        setStatusMessage(
          next.pauseKind === 'review'
            ? `Waiting for human review on ${next.stage ?? 'current stage'}.`
            : `Waiting for clarification on ${next.stage ?? 'current stage'}.`,
        )
      } else if (next.status === 'completed') {
        setStatusMessage('Flow completed.')
        eventSource.close()
      } else if (next.status === 'error') {
        setStatusMessage(`Error: ${next.error ?? 'Unknown error'}`)
        eventSource.close()
      } else {
        setStatusMessage(`Running ${next.stage ?? 'flow'}...`)
      }
    }

    eventSource.onerror = () => {
      setStatusMessage((current) => `${current} Connection lost.`)
      eventSource.close()
    }
  }

  function disconnectEvents() {
    eventSourceRef.current?.close()
    eventSourceRef.current = null
  }

  function setField<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }))
  }

  function applyPreset(preset: (typeof presets)[number]) {
    setForm((current) => ({
      ...current,
      feature: preset.feature,
      planContext: preset.planContext,
      withClarify: true,
      withImplement: true,
    }))
  }

  return (
    <main className="app-shell">
      <section className="hero card">
        <div>
          <p className="eyebrow">Pi SDK × Spec Kit</p>
          <h1>PDLC control center</h1>
          <p className="hero-copy">
            Launch a product development lifecycle flow, watch the output stream live, and answer clarification prompts without leaving the browser.
          </p>
        </div>
        <div className="hero-actions">
          {presets.map((preset) => (
            <button key={preset.label} className="ghost-button" onClick={() => applyPreset(preset)} type="button">
              {preset.label}
            </button>
          ))}
        </div>
      </section>

      <section className="content-grid">
        <form className="card panel" onSubmit={(event) => {
          event.preventDefault()
          void startRun(false)
        }}>
          <div className="panel-header">
            <h2>Run setup</h2>
            <span className={`badge ${run?.status ?? 'idle'}`}>{run?.status ?? 'idle'}</span>
          </div>

          <label>
            Target repository path
            <input value={form.cwd} onChange={(event) => setField('cwd', event.target.value)} placeholder="/absolute/path/to/repo" />
          </label>

          <label>
            Feature description
            <textarea value={form.feature} onChange={(event) => setField('feature', event.target.value)} placeholder="Add reusable signing templates" />
          </label>

          <label>
            Constitution input
            <input value={form.constitution} onChange={(event) => setField('constitution', event.target.value)} placeholder="AI-assisted secure document workflow" />
          </label>

          <label>
            Planning context
            <textarea value={form.planContext} onChange={(event) => setField('planContext', event.target.value)} placeholder="Use Bun for the CLI and keep generated artifacts in the target repo" />
          </label>

          <div className="input-grid">
            <label>
              Custom stages
              <input value={form.stages} onChange={(event) => setField('stages', event.target.value)} placeholder="init,constitution,specify,clarify,plan,tasks,analyze,implement" />
            </label>
            <label>
              Model
              <input value={form.model} onChange={(event) => setField('model', event.target.value)} placeholder="anthropic/claude-sonnet-4-5:high" />
            </label>
            <label>
              Thinking
              <input value={form.thinking} onChange={(event) => setField('thinking', event.target.value)} placeholder="off, low, medium, high" />
            </label>
          </div>

          <div className="toggle-grid">
            <label className="toggle"><input checked={form.withConstitution} onChange={(event) => setField('withConstitution', event.target.checked)} type="checkbox" />With constitution</label>
            <label className="toggle"><input checked={form.withClarify} onChange={(event) => setField('withClarify', event.target.checked)} type="checkbox" />With clarify</label>
            <label className="toggle"><input checked={form.withImplement} onChange={(event) => setField('withImplement', event.target.checked)} type="checkbox" />With implement</label>
            <label className="toggle"><input checked={form.persistSession} onChange={(event) => setField('persistSession', event.target.checked)} type="checkbox" />Persist session</label>
            <label className="toggle"><input checked={form.reviewHarness} onChange={(event) => setField('reviewHarness', event.target.checked)} type="checkbox" />Review harness</label>
            <label className="toggle"><input checked={form.humanInLoop} onChange={(event) => setField('humanInLoop', event.target.checked)} type="checkbox" />Human in loop</label>
            <label className="toggle"><input checked={form.verbose} onChange={(event) => setField('verbose', event.target.checked)} type="checkbox" />Verbose logs</label>
          </div>

          <div className="button-row">
            <button className="primary-button" disabled={busy} type="submit">{busy ? 'Starting…' : 'Start flow'}</button>
            <button className="secondary-button" disabled={busy} onClick={() => void startRun(true)} type="button">Dry run</button>
          </div>
        </form>

        <section className="card panel panel-wide">
          <div className="panel-header">
            <div>
              <h2>Live output</h2>
              <p className="panel-subtitle">{runMeta}</p>
            </div>
            <span className="status-copy">{statusMessage}</span>
          </div>

          <pre className="log-viewer" ref={logRef}>{dryRunOutput || run?.log || 'No run yet.'}</pre>

          {canAnswer && (
            <div className="clarify-box">
              <div>
                <h3>{run?.pauseKind === 'review' ? 'Human review gate' : 'Clarification needed'}</h3>
                <p>
                  {run?.pauseKind === 'review'
                    ? 'Approve to continue, or enter requested changes for the agent to apply and re-review.'
                    : 'Reply in the same format requested by the Spec Kit prompt.'}
                </p>
              </div>
              <textarea
                value={clarification}
                onChange={(event) => setClarification(event.target.value)}
                placeholder={run?.pauseKind === 'review' ? 'approve  — or describe requested changes' : 'Q1: A, Q2: Custom - ...'}
              />
              <div className="button-row">
                {run?.pauseKind === 'review' && (
                  <button className="secondary-button" disabled={busy} onClick={() => setClarification('approve')} type="button">
                    Fill approve
                  </button>
                )}
                <button className="primary-button" disabled={busy || !clarification.trim()} onClick={() => void submitAnswer()} type="button">Send answer</button>
              </div>
            </div>
          )}
        </section>
      </section>
    </main>
  )
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

  return (await response.json()) as T
}

createRoot(document.getElementById('root')!).render(<App />)
