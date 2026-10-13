import { useCallback, useEffect, useState } from 'react'
import { json } from './auth'
import { SkeletonRows } from './loading'

/**
 * Project workers, for the deployment's super admin (specs/014-project-workers):
 * each project's Railway worker service, the provisioning token check, and
 * retry or remove per worker.
 */

interface WorkerRow {
  projectId: string
  projectName: string
  projectCode: string | null
  internalUrl: string | null
  railwayServiceId: string | null
  state: string
  version: string | null
  lastError: string | null
  updatedAt: string
}

interface CheckResult {
  configured: boolean
  tokenType?: string
  canRead?: boolean
  services?: number
  canCreate?: boolean
  error?: string
}

const STATE_TONE: Record<string, string> = { ready: 'completed', provisioning: 'running', updating: 'running', failed: 'error', sleeping: 'idle', pending: 'idle', removing: 'running' }

export function WorkersSection() {
  const [data, setData] = useState<{ role: string; provisioning: boolean; workers: WorkerRow[] } | null>(null)
  const [check, setCheck] = useState<CheckResult | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try { setData(await json('/api/admin/workers')) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [])
  useEffect(() => { void load() }, [load])

  async function runCheck(probe: boolean) {
    if (probe && !window.confirm('Create a throwaway service and volume in the Railway project, then delete them straight away?')) return
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
        <span className="panel-subtitle">role <code>{data.role}</code> · provisioning {data.provisioning ? 'set up' : 'not set up'}</span>
      </div>
      <p className="panel-subtitle">
        Each project runs on its own Railway service with its own disk. The check confirms the provisioning token
        (<code>RAILWAY_PROVISIONER_TOKEN</code>) can read this Railway project; the probe also creates and deletes a throwaway service and volume.
      </p>
      <div className="button-row">
        <button type="button" className="secondary-button small-button" disabled={Boolean(busy)} onClick={() => void runCheck(false)}>Check the token</button>
        <button type="button" className="ghost-button small-button" disabled={Boolean(busy) || !data.provisioning} onClick={() => void runCheck(true)}>Probe create and delete</button>
      </div>
      {check && (
        <ul className="worker-check">
          <li>Token set: <strong>{check.configured ? `yes (${check.tokenType})` : 'no'}</strong></li>
          {check.canRead !== undefined && <li>Reads this Railway project: <strong>{check.canRead ? `yes (${check.services} services)` : 'no'}</strong></li>}
          {check.canCreate !== undefined && <li>Creates services and volumes: <strong>{check.canCreate ? 'yes' : 'no'}</strong></li>}
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
                  <td><strong>{worker.projectName}</strong>{worker.projectCode && <div className="text-subtle">{worker.projectCode}</div>}</td>
                  <td>
                    <span className={`mini-badge ${STATE_TONE[worker.state] ?? 'idle'}`}>{worker.state}</span>
                    {worker.lastError && <div className="error-text">{worker.lastError}</div>}
                  </td>
                  <td>{worker.internalUrl ? <code>{worker.internalUrl}</code> : <span className="text-subtle">—</span>}</td>
                  <td>
                    <div className="button-row">
                      {worker.state !== 'ready' && <button type="button" className="secondary-button small-button" disabled={busy === worker.projectId || !data.provisioning} onClick={() => void act(worker, 'provision')}>Retry</button>}
                      {worker.railwayServiceId && <button type="button" className="ghost-button small-button" disabled={busy === worker.projectId} onClick={() => void act(worker, 'remove')}>Remove</button>}
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
