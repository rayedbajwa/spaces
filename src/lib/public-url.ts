/**
 * The origin users see, for links and OAuth callbacks.
 *
 * Behind a TLS-terminating proxy (Railway, Fly, Render, Cloud Run, nginx) the
 * request reaches Bun over plain HTTP on an internal port, so `url.origin`
 * would say `http://…` and OAuth callbacks and GitHub App manifests would be
 * registered with the wrong scheme. PUBLIC_URL wins when set; otherwise the
 * standard forwarded headers are honoured; otherwise the request URL is used.
 */

export function publicOrigin(req: Request, url: URL = new URL(req.url)): string {
  const configured = process.env.PUBLIC_URL?.trim()
  if (configured) {
    try { return new URL(configured).origin } catch { /* fall through to headers */ }
  }
  const forwardedHost = firstValue(req.headers.get('x-forwarded-host'))
  const forwardedProto = firstValue(req.headers.get('x-forwarded-proto'))
  if (forwardedHost) {
    const proto = forwardedProto === 'http' || forwardedProto === 'https' ? forwardedProto : url.protocol.replace(':', '')
    return `${proto}://${forwardedHost}`
  }
  if (forwardedProto === 'https' && url.protocol === 'http:') return `https://${url.host}`
  return url.origin
}

/** Forwarded headers may hold a comma-separated chain; the first entry is the client-facing one. */
function firstValue(header: string | null): string | undefined {
  const first = header?.split(',')[0]?.trim()
  return first || undefined
}
