import { configuredProviders } from './default-model'
import { warmModelRouting } from './model-policy'
import { leftoverEnvKeys, listProviderKeys } from './provider-keys'

type Log = { warn: (msg: string, meta?: Record<string, unknown>) => void; info: (msg: string, meta?: Record<string, unknown>) => void }

/**
 * Boot-time report on LLM provider keys: which providers are configured (from
 * the encrypted store), how their last verification went, and the routing the
 * deployment will use. Keys left in .env are called out as ignored.
 */
export async function checkProviderKeys(log: Log): Promise<void> {
  const leftovers = leftoverEnvKeys()
  if (leftovers.length) log.warn(`${leftovers.join(', ')} are set in the environment but ignored; provider keys are managed under Organization → Models. Remove them from .env.`)
  const providers = configuredProviders()
  await warmModelRouting(log).catch((error) => log.warn('model routing could not be computed', { error: error instanceof Error ? error.message : String(error) }))
  if (providers.length === 0) {
    log.warn('No LLM provider key is stored; add one under Organization → Models or every agent step will fail.')
    return
  }
  for (const key of await listProviderKeys().catch(() => [])) {
    if (!key.configured) continue
    if (key.lastVerifyStatus === 'ok') log.info(`${key.label} API key verified`, { at: key.lastVerifiedAt })
    else log.warn(`${key.label} API key last verification: ${key.lastVerifyStatus ?? 'unknown'}`, { error: key.lastVerifyError })
  }
}

/** @deprecated use checkProviderKeys */
export const checkAnthropicKey = checkProviderKeys
