import process from 'node:process'

/**
 * Boot-time sanity check for the Anthropic key. A shell variable silently
 * overrides `.env`, so a process started with a placeholder key (e.g. from a
 * test shell) makes every agent call fail with 401 while nothing in the UI
 * explains why. This surfaces that at startup instead.
 */
export async function checkAnthropicKey(log: { warn: (msg: string, meta?: Record<string, unknown>) => void; info: (msg: string, meta?: Record<string, unknown>) => void }): Promise<void> {
  const key = process.env.ANTHROPIC_API_KEY?.trim()
  if (!key) {
    log.warn('ANTHROPIC_API_KEY is not set; Anthropic models will fail. Set it in .env.')
    return
  }
  if (key.length < 40 || !key.startsWith('sk-ant-')) {
    log.warn('ANTHROPIC_API_KEY does not look like a real key (placeholder from the shell?). It overrides .env — unset it or fix it, then restart.', { length: key.length })
  }
  try {
    const response = await fetch('https://api.anthropic.com/v1/models?limit=1', {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      signal: AbortSignal.timeout(8_000),
    })
    if (response.status === 401) {
      log.warn('ANTHROPIC_API_KEY was rejected by Anthropic (401 invalid x-api-key). Every agent step and assistant reply will fail until the process is restarted with a valid key.', { length: key.length })
    } else if (response.status === 403) {
      log.warn('ANTHROPIC_API_KEY is valid but not permitted (403); check the key\'s workspace and plan.')
    } else if (!response.ok) {
      log.warn('Anthropic key check returned an unexpected status', { status: response.status })
    } else {
      log.info('Anthropic API key verified', { length: key.length })
    }
  } catch (error) {
    log.warn('Could not reach Anthropic to verify the API key (offline?)', { error: error instanceof Error ? error.message : String(error) })
  }
}
