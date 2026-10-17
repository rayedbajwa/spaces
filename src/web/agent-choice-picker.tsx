import type { AgentQuestion } from './agent-choices'

export const OTHER_CHOICE = 'other'

/**
 * The agent's options as a single-choice list, with "Other" for an answer of
 * your own. The details box below it (owned by the dock) adds information to
 * whichever option is picked.
 */
export function AgentChoicePicker({ question, picked, onPick, name }: {
  question: AgentQuestion
  picked: string | null
  onPick: (key: string) => void
  name: string
}) {
  return (
    <div className="agent-choices" role="radiogroup" aria-label={question.title ?? 'Choose an answer'}>
      {question.title && <div className="agent-choices-title">{question.title}</div>}
      {[...question.choices, { key: OTHER_CHOICE, label: 'Other', detail: 'Write your own answer below' }].map((choice) => {
        const selected = picked === choice.key
        return (
          <label key={choice.key} className={`agent-choice ${selected ? 'selected' : ''}`}>
            <input type="radio" name={name} value={choice.key} checked={selected} onChange={() => onPick(choice.key)} />
            {!question.yesNo && choice.key !== OTHER_CHOICE && <span className="agent-choice-key">{choice.key}</span>}
            <span className="agent-choice-text">
              <span className="agent-choice-label">
                {choice.label}
                {'recommended' in choice && choice.recommended && <span className="mini-badge agent-choice-rec">recommended</span>}
              </span>
              {choice.detail && <span className="agent-choice-detail">{choice.detail}</span>}
            </span>
          </label>
        )
      })}
      {question.recommendedReason && <div className="agent-choices-why">Why recommended: {question.recommendedReason}</div>}
    </div>
  )
}
