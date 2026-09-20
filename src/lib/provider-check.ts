import { warmModelRouting } from './model-policy'
import { listOrganizations } from './orgs'
import { configuredProvidersFor, leftoverEnvKeys, listProviderKeys } from './provider-keys'

type Log = { warn: (msg: string, meta?: Record<string, unknown>) => void; info: (msg: string, meta?: Record<string, unknown>) => void }

/**
 * Boot-time report on LLM provider keys, per organization: which providers
 * are configured (from the encrypted store), how their last verification
 * went, and the routing each organization will use. Keys left in .env are
 * called out as ignored.
 */
export async function checkProviderKeys(log: Log): Promise<void> {
  const leftovers = leftoverEnvKeys()
  if (leftovers.length) log.warn(`${leftovers.join(', ')} are set in the environment but ignored; provider keys are managed under Organization → Models. Remove them from .env.`)
  const orgs = await listOrganizations().catch(() => [])
  for (const org of orgs) {
    const providers = await configuredProvidersFor(org.orgId).catch(() => [])
    await warmModelRouting(org.orgId, log).catch((error) => log.warn('model routing could not be computed', { org: org.slug, error: error instanceof Error ? error.message : String(error) }))
    if (providers.length === 0) {
      log.warn(`Organization "${org.name}" has no LLM provider key; add one under Organization → Models or every agent step will fail.`)
      continue
    }
    for (const key of await listProviderKeys(org.orgId).catch(() => [])) {
      if (!key.configured) continue
      if (key.lastVerifyStatus === 'ok') log.info(`${key.label} API key verified`, { org: org.slug, at: key.lastVerifiedAt })
      else log.warn(`${key.label} API key last verification: ${key.lastVerifyStatus ?? 'unknown'}`, { org: org.slug, error: key.lastVerifyError })
    }
  }
}

/** @deprecated use checkProviderKeys */
export const checkAnthropicKey = checkProviderKeys
