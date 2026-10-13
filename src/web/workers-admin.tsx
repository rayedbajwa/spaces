import { useCallback, useEffect, useState } from 'react'
import { json } from './auth'
import { SkeletonRows } from './loading'

/**
 * Project workers, for the deployment's super admin (specs/014-project-workers):
 * each project's worker on Railway, Kubernetes or Docker, the platform check,
 * and retry or remove per worker.
 */

interface WorkerRow {
  projectId: string
  projectName: string
  projectCode: string | null
  internalUrl: string | null
  platform: string | null
  serviceRef: string | null
  state: string
  version: string | null
  lastError: string | null
  updatedAt: string
}

interface CheckResult {
  configured: boolean
  platform?: string
  canRead?: boolean
  detail?: string
  canCreate?: boolean
  error?: string
}

const STATE_TONE: Record<string, string> = { ready: 'completed', provisioning: 'running', updating: 'running', failed: 'error', sleeping: 'idle', pending: 'idle', removing: 'running' }

export function WorkersSection() {
  const [data, setData] = useState<{ role: string; platform: string | null; problem: string | null; workers: WorkerRow[] } | null>(null)
  const [check, setCheck] = useState<CheckResult | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try { setData(await json('/api/admin/workers')) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function runCheck(probe: boolean) {
    if (probe && !window.confirm(data?.platform === 'kubernetes' ? 'Ask the cluster to validate creating a worker (server-side dry run; nothing is created)?' : 'Create a throwaway service or volume on the platform, then delete it straight away?')) return
    setBusy(probe ? 'probe' : 'check'); setError('')
    try { setCheck(await json<CheckResult>('/api/admin/workers/check', { method: 'POST', body: JSON.stringify({ probe }) })) } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy('') }
  }

  async function act(worker: WorkerRow, action: 'provision' | 'remove') {
    if (action === 'remove' && !window.confirm(`Remove ${worker.projectName}'s worker service and its volume? Its workspace files are deleted.`)) return
    setBusy(worker.projectId); setError('')
    try {
      await json(`/api/admin/workers/${worker.projectId}${action === 'provision' ? '/provision' : ''}`, { method: action === 'provision' ? 'POST' : 'DELETE', ...(action === 'provision' ? { body: '{}' } : {}) })
      await load()
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy('') }
  }

  if (data === null) return error ? <p className="error-text">{error}</p> : <SkeletonRows count={3} label="Loading project workers…" />

  return (
    <section className="card panel team-section">
      <div className="team-section-head">
        <h3>Project workers</h3>
        <span className="panel-subtitle">role <code>{data.role}</code> · platform {data.platform ? <code>{data.platform}</code> : 'not set up'}</span>
      </div>
      <p className="panel-subtitle">
        Each project runs on its own worker with its own disk, on Railway, Kubernetes or the local Docker engine.
        The check confirms Spaces can reach the platform; the probe also confirms it may create what a worker needs.
      </p>
      {data.problem && <p className="error-text">{data.problem}</p>}
      <div className="button-row">
        <button type="button" className="secondary-button small-button" disabled={Boolean(busy)} onClick={() => void runCheck(false)}>Check the token</button>
        <button type="button" className="ghost-button small-button" disabled={Boolean(busy) || !data.platform} onClick={() => void runCheck(true)}>Probe create and delete</button>
      </div>
      {check && (
        <ul className="worker-check">
          <li>Platform set up: <strong>{check.configured ? `yes (${check.platform})` : 'no'}</strong></li>
          {check.canRead !== undefined && <li>Reachable: <strong>{check.canRead ? `yes${check.detail ? ` — ${check.detail}` : ''}` : 'no'}</strong></li>}
          {check.canCreate !== undefined && <li>May create workers and volumes: <strong>{check.canCreate ? 'yes' : 'no'}</strong></li>}
          {check.error && <li className="error-text">{check.error}</li>}
        </ul>
      )}
      {error && <p className="error-text">{error}</p>}
      {data.workers.length === 0 && <p className="empty-state">No project has a worker yet.</p>}
      {data.workers.length > 0 && (
        <div className="table-wrap">
          <table className="project-table">
            <thead><tr><th>Project</th><th>State</th><th>Address</th><th /></tr></thead>
            <tbody>
              {data.workers.map((worker) => (
                <tr key={worker.projectId}>
                  <td><strong>{worker.projectName}</strong><div className="text-subtle">{[worker.projectCode, worker.platform].filter(Boolean).join(' · ')}</div></td>
                  <td>
                    <span className={`mini-badge ${STATE_TONE[worker.state] ?? 'idle'}`}>{worker.state}</span>
                    {worker.lastError && <div className="error-text">{worker.lastError}</div>}
                  </td>
                  <td>{worker.internalUrl ? <code>{worker.internalUrl}</code> : <span className="text-subtle">—</span>}</td>
                  <td>
                    <div className="button-row">
                      {worker.state !== 'ready' && <button type="button" className="secondary-button small-button" disabled={busy === worker.projectId || !data.platform} onClick={() => void act(worker, 'provision')}>Retry</button>}
                      {(worker.serviceRef) && <button type="button" className="ghost-button small-button" disabled={busy === worker.projectId} onClick={() => void act(worker, 'remove')}>Remove</button>}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
