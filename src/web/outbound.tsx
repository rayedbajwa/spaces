import { useCallback, useEffect, useState } from 'react'
import { json } from './auth'
import { LoadingBlock } from './loading'
import { PageHead } from './shell'

/**
 * Outbound triggers (012-inbound-outbound-slack, US4).
 *
 * Configure per-event subscriptions that perform a reversible action in Jira,
 * Linear, GitHub or Slack when a notable event fires: run failed, gate opened,
 * stage completed, verification completed, feature delivered. A subscription
 * can be disabled without deleting it; recent deliveries show retries/outcomes.
 */

type EventKind = 'run_failed' | 'gate_opened' | 'stage_completed' | 'verification_completed' | 'feature_delivered'
type TargetKind = 'jira' | 'linear' | 'github' | 'slack'
type Action = 'comment' | 'update_issue' | 'create_issue' | 'post_message'

interface Subscription {
  subscriptionId: string; projectId: string | null; eventKind: EventKind; targetKind: TargetKind
  action: Action; targetConfig: Record<string, unknown>; enabled: boolean; updatedAt: string
}
interface Delivery { deliveryId: string; eventKind: string; eventKey: string; state: string; attempts: number; lastError: string | null; createdAt?: string }

const EVENTS: EventKind[] = ['run_failed', 'gate_opened', 'stage_completed', 'verification_completed', 'feature_delivered']
const TARGETS: TargetKind[] = ['jira', 'linear', 'github', 'slack']
const ACTIONS_BY_TARGET: Record<TargetKind, Action[]> = {
  jira: ['comment', 'update_issue'],
  linear: ['comment', 'create_issue'],
  github: ['create_issue', 'comment'],
  slack: ['post_message'],
}

export function OutboundPage() {
  const [subscriptions, setSubscriptions] = useState<Subscription[]>([])
  const [deliveries, setDeliveries] = useState<Delivery[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [eventKind, setEventKind] = useState<EventKind>('run_failed')
  const [targetKind, setTargetKind] = useState<TargetKind>('slack')
  const [action, setAction] = useState<Action>('post_message')
  const [configText, setConfigText] = useState('{ "channel": "#spaces-alerts" }')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await json<{ subscriptions: Subscription[]; deliveries: Delivery[] }>('/api/outbound/subscriptions')
      setSubscriptions(data.subscriptions)
      setDeliveries(data.deliveries)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setLoading(false)
    }
  }, [])
  useEffect(() => { void load() }, [load])

  useEffect(() => {
    const actions = ACTIONS_BY_TARGET[targetKind]
    if (!actions.includes(action)) setAction(actions[0]!)
  }, [targetKind, action])

  const save = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      let targetConfig: Record<string, unknown>
      try { targetConfig = JSON.parse(configText || '{}') } catch { throw new Error('Target config must be valid JSON.') }
      await json('/api/outbound/subscriptions', { method: 'PUT', body: JSON.stringify({ eventKind, targetKind, action, targetConfig }) })
      setMessage('Subscription saved.')
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const toggle = async (subscription: Subscription): Promise<void> => {
    setBusy(true)
    try {
      await json('/api/outbound/subscriptions', { method: 'PUT', body: JSON.stringify({ ...subscription, enabled: !subscription.enabled }) })
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (subscription: Subscription): Promise<void> => {
    if (!window.confirm(`Delete the ${subscription.eventKind} → ${subscription.targetKind} subscription?`)) return
    setBusy(true)
    try {
      await json(`/api/outbound/subscriptions/${encodeURIComponent(subscription.subscriptionId)}`, { method: 'DELETE' })
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHead title="Outbound triggers" subtitle="Fire a reversible action in another tool when a notable Spaces event happens." />
      {message && <div className="toast" role="status"><span>{message}</span><button type="button" className="ghost-button toast-close" onClick={() => setMessage(null)} aria-label="Dismiss">×</button></div>}

      <section className="panel card" aria-label="Add a subscription">
        <h2 className="section-title">Add a subscription</h2>
        <div className="outbound-form">
          <label className="intake-action">Event
            <select value={eventKind} onChange={(e) => setEventKind(e.target.value as EventKind)}>
              {EVENTS.map((kind) => <option value={kind}>{kind.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <label className="intake-action">Target
            <select value={targetKind} onChange={(e) => setTargetKind(e.target.value as TargetKind)}>
              {TARGETS.map((target) => <option value={target}>{target}</option>)}
            </select>
          </label>
          <label className="intake-action">Action
            <select value={action} onChange={(e) => setAction(e.target.value as Action)}>
              {ACTIONS_BY_TARGET[targetKind].map((candidate) => <option value={candidate}>{candidate.replace(/_/g, ' ')}</option>)}
            </select>
          </label>
          <label className="intake-action grow">Target config (JSON)
            <input value={configText} onChange={(e) => setConfigText(e.target.value)} spellCheck={false} />
          </label>
          <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>Save</button>
        </div>
      </section>

      {loading && subscriptions.length === 0 ? <LoadingBlock label="Loading subscriptions…" /> : (
        <section className="panel card" aria-label="Subscriptions">
          <h2 className="section-title">Subscriptions</h2>
          {subscriptions.length === 0 && <p className="muted">No subscriptions. Events happen as normal but nothing is sent anywhere.</p>}
          <div className="outbound-list">
            {subscriptions.map((subscription) => (
              <div className={`outbound-row ${subscription.enabled ? '' : 'disabled'}`}>
                <span className="outbound-event">{subscription.eventKind.replace(/_/g, ' ')}</span>
                <span className="outbound-arrow">→</span>
                <span className="outbound-target">{subscription.targetKind} · {subscription.action.replace(/_/g, ' ')}</span>
                <code className="outbound-config">{JSON.stringify(subscription.targetConfig)}</code>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => void toggle(subscription)}>{subscription.enabled ? 'Disable' : 'Enable'}</button>
                <button type="button" className="ghost-button" disabled={busy} onClick={() => void remove(subscription)}>Delete</button>
              </div>
            ))}
          </div>
        </section>
      )}

      {deliveries.length > 0 && (
        <section className="panel card" aria-label="Recent deliveries">
          <h2 className="section-title">Recent deliveries</h2>
          <div className="outbound-list">
            {deliveries.slice(0, 20).map((delivery) => (
              <div className="outbound-row">
                <span className={`delivery-badge delivery-${delivery.state}`}>{delivery.state}</span>
                <span className="outbound-event">{delivery.eventKey}</span>
                <span className="outbound-target">{delivery.attempts} attempt{delivery.attempts === 1 ? '' : 's'}</span>
                {delivery.lastError && <span className="outbound-error" title={delivery.lastError}>{delivery.lastError}</span>}
              </div>
            ))}
          </div>
        </section>
      )}
    </>
  )
}
