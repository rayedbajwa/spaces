/**
 * A word or two ("tst") gives the agent nothing to specify: it declines and no
 * feature is created. Shared by the browser prompt and the execute-step route,
 * so the Assistant and API callers get the same answer.
 */
export const MIN_FEATURE_WORDS = 4

/** Why a feature description cannot be specified, or undefined when it can. */
export function featureDescriptionProblem(value: string | undefined): string | undefined {
  const text = value?.trim() ?? ''
  if (!text) return 'The specify stage requires an intent description.'
  if (text.split(/\s+/).length < MIN_FEATURE_WORDS) {
    return `"${text}" is too short to specify. Describe the intent in a sentence: who does what, and how you'll know it works.`
  }
  return undefined
}
