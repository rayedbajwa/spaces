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
  active: boolean
  migrationState: string | null
  migrationJson: { error?: string; files?: number; bytes?: number; direction?: string } | null
  migrationAt: string | null
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
  const [data, setData] = useState<{ role: string; platform: string | null; problem: string | null; workers: WorkerRow[]; projects: Array<{ projectId: string; name: string; code: string | null }>; version: string; awake: string[]; maxAwake: number; waiting: Array<{ projectId: string; name: string; since: string }> } | null>(null)
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

  async function move(projectId: string, name: string, action: 'copy' | 'move' | 'move-back') {
    const question = action === 'copy'
      ? `Copy ${name}'s files to its own worker and check them? The shared service keeps running the project.`
      : action === 'move'
        ? `Move ${name} to its own worker? Its jobs are held while the files are copied again and checked; then the worker runs the project.`
        : `Move ${name} back to the shared service? Its files are copied back from the worker and checked first.`
    if (!window.confirm(question)) return
    setBusy(projectId); setError('')
    try { await json(`/api/admin/workers/${projectId}/${action}`, { method: 'POST', body: '{}' }); await load() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy('') }
  }

  // A move takes minutes: follow it.
  const moving = data?.workers.some((w) => ['copying', 'syncing', 'moving_back'].includes(w.migrationState ?? ''))
  useEffect(() => {
    if (!moving) return
    const timer = window.setInterval(() => { void load() }, 5_000)
    return () => window.clearInterval(timer)
  }, [moving, load])

  if (data === null) return error ? <p className="error-text">{error}</p> : <SkeletonRows count={3} label="Loading project workers…" />
  const workerFor = new Map(data.workers.map((w) => [w.projectId, w]))
  const describeMove = (w?: WorkerRow) => {
    if (!w?.migrationState) return w?.active ? 'own worker' : 'shared service'
    const size = w.migrationJson?.files !== undefined ? ` (${w.migrationJson.files} files, ${Math.round((w.migrationJson.bytes ?? 0) / 1024 / 1024)} MB)` : ''
    return ({ copying: 'copying…', syncing: 'moving…', moving_back: 'moving back…', verified: `copy checked${size}`, moved: `moved${size}`, failed: 'move failed' } as Record<string, string>)[w.migrationState] ?? w.migrationState
  }

  return (
    <section className="card panel team-section">
      <div className="team-section-head">
        <h3>Project workers</h3>
        <span className="panel-subtitle">role <code>{data.role}</code> · version <code>{data.version.slice(0, 7)}</code> · platform {data.platform ? <code>{data.platform}</code> : 'not set up'} · {data.awake.length}/{data.maxAwake} awake</span>
      </div>
      <p className="panel-subtitle">
        Each project runs on its own worker with its own disk, on Railway, Kubernetes or the local Docker engine.
        The check confirms Spaces can reach the platform; the probe also confirms it may create what a worker needs.
      </p>
      {data.problem && <p className="error-text">{data.problem}</p>}
      {data.waiting.length > 0 && (
        <p className="error-text">
          At the limit of {data.maxAwake} awake workers. Waiting for a free worker: {data.waiting.map((w) => w.name).join(', ')}.
          Raise <code>PROJECT_WORKERS_MAX_AWAKE</code> or wait for one to go idle.
        </p>
      )}
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
            <thead><tr><th>Project</th><th>State</th><th>Version</th><th>Address</th><th /></tr></thead>
            <tbody>
              {data.workers.map((worker) => (
                <tr key={worker.projectId}>
                  <td><strong>{worker.projectName}</strong><div className="text-subtle">{[worker.projectCode, worker.platform].filter(Boolean).join(' · ')}</div></td>
                  <td>
                    <span className={`mini-badge ${STATE_TONE[worker.state] ?? 'idle'}`}>{worker.state}</span>
                    {worker.state === 'ready' && <span className={`mini-badge ${data.awake.includes(worker.projectId) ? 'running' : 'idle'}`}>{data.awake.includes(worker.projectId) ? 'working' : 'idle'}</span>}
                    {worker.lastError && <div className="error-text">{worker.lastError}</div>}
                  </td>
                  <td>
                    {worker.version ? <code>{worker.version.slice(0, 7)}</code> : <span className="text-subtle">—</span>}
                    {worker.version && data.version !== 'unknown' && worker.version !== data.version && worker.state === 'ready' && <div className="text-subtle">update waits until idle</div>}
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
      {data.role !== 'project' && data.platform && data.projects.length > 0 && (
        <>
          <h4 className="workers-subhead">Existing projects</h4>
          <p className="panel-subtitle">
            Move projects one at a time. <strong>Copy</strong> is a dry run: it creates the worker and copies and checks the files while the shared service keeps the project.
            <strong> Move</strong> holds the project's jobs, copies again and hands it to its worker. <strong>Move back</strong> returns it, with the worker's files.
          </p>
          <div className="table-wrap">
            <table className="project-table">
              <thead><tr><th>Project</th><th>Runs on</th><th /></tr></thead>
              <tbody>
                {data.projects.map((project) => {
                  const worker = workerFor.get(project.projectId)
                  const inMotion = ['copying', 'syncing', 'moving_back'].includes(worker?.migrationState ?? '')
                  return (
                    <tr key={project.projectId}>
                      <td><strong>{project.name}</strong>{project.code && <div className="text-subtle">{project.code}</div>}</td>
                      <td>
                        <span className={`mini-badge ${worker?.active ? 'completed' : worker?.migrationState === 'failed' ? 'error' : inMotion ? 'running' : 'idle'}`}>{describeMove(worker)}</span>
                        {worker?.migrationState === 'failed' && worker.migrationJson?.error && <div className="error-text">{worker.migrationJson.error}</div>}
                      </td>
                      <td>
                        <div className="button-row">
                          {!worker?.active && <button type="button" className="ghost-button small-button" disabled={busy === project.projectId || inMotion} onClick={() => void move(project.projectId, project.name, 'copy')}>Copy (dry run)</button>}
                          {!worker?.active && <button type="button" className="secondary-button small-button" disabled={busy === project.projectId || inMotion} onClick={() => void move(project.projectId, project.name, 'move')}>Move</button>}
                          {worker?.active && data.role === 'all' && <button type="button" className="ghost-button small-button" disabled={busy === project.projectId || inMotion} onClick={() => void move(project.projectId, project.name, 'move-back')}>Move back</button>}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  )
}
