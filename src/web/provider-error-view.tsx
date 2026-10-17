import { describeProviderError } from '../lib/provider-error'

/**
 * A run's error. Provider failures (credits, keys, rate limits) show as a
 * plain title and message with links to fix them at that provider; the full
 * text stays one click away. Anything else shows as it was recorded.
 */
export function RunErrorDetail({ error }: { error?: string }) {
  const view = describeProviderError(error)
  if (!view) return <p className="notice-body">{error ?? 'No error detail recorded.'}</p>
  const minutes = view.retryAfterSeconds ? Math.max(1, Math.round(view.retryAfterSeconds / 60)) : 0
  return (
    <div className="provider-error">
      <strong className="provider-error-title">{view.title}</strong>
      <p className="provider-error-message">{view.message}</p>
      {minutes > 0 && <p className="provider-error-retry">{view.providerName ?? 'The provider'} suggests retrying in about {minutes} minute{minutes === 1 ? '' : 's'}.</p>}
      {view.links.length > 0 && (
        <div className="button-row provider-error-links">
          {view.links.map((link, i) => (
            <a key={link.href} className={i === 0 ? 'primary-button' : 'secondary-button'} href={link.href} target="_blank" rel="noreferrer noopener">{link.label} ↗</a>
          ))}
        </div>
      )}
      <details className="provider-error-raw">
        <summary>Full error</summary>
        <pre>{error}</pre>
      </details>
    </div>
  )
}

/** One line for status messages: "Out of OpenRouter credits: This request would…". */
export function runErrorLine(error?: string): string {
  const view = describeProviderError(error)
  return view ? `${view.title}: ${view.message}` : (error ?? 'Unknown error')
}

/** The same, as markdown for the assistant chat, with the fix-it links. */
export function runErrorMarkdown(error: string): string {
  const view = describeProviderError(error)
  if (!view) return `Error: ${error}`
  const retry = view.retryAfterSeconds ? ` Retry in about ${Math.max(1, Math.round(view.retryAfterSeconds / 60))} min.` : ''
  const links = view.links.map((l) => `[${l.label} ↗](${l.href})`).join(' · ')
  return `**${view.title}.** ${view.message}${retry}${links ? `\n\n${links}` : ''}`
}
