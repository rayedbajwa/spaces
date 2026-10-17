/**
 * The landing page's words, shared by the React page (src/web/landing.tsx) and
 * the server, which puts the same text into the HTML for crawlers and link
 * previews that do not run JavaScript (src/lib/seo.ts).
 */

export const DOCS_URL = 'https://rayedbajwa.github.io/spaces/'
export const REPO_URL = 'https://github.com/rayedbajwa/spaces'

export const TAGLINE = 'The AI software factory for your team.'
export const LEDE = 'Specs go in, reviewed and tested pull requests come out.'
export const SUMMARY = 'Spaces runs every feature down an assembly line of specialised agents that know your codebase, your conventions and the tickets behind the work. You approve at the gates; the factory does the rest.'

export interface Station { name: string; does: string; gate?: boolean }

export const STATIONS: Station[] = [
  { name: 'Research', does: 'Clones the repositories the work needs, learns them and loads your knowledge base.' },
  { name: 'Specify', does: 'Turns the ticket or idea into a specification with acceptance criteria.', gate: true },
  { name: 'Plan', does: 'Chooses the approach, the repositories touched and the workstreams.', gate: true },
  { name: 'Tasks', does: 'Breaks the plan into ordered, testable tasks per repository.', gate: true },
  { name: 'Implement', does: 'Writes the code, runs the tests, fixes lint and CI, opens the pull requests.', gate: true },
  { name: 'Review', does: 'Reviews the code and loops with implement until it is approved.' },
  { name: 'Verify', does: 'Tests the affected flows end to end, in a real browser when needed.', gate: true },
  { name: 'Deliver', does: 'Drives CI, merge, deploy and UAT, and asks before it merges or deploys.' },
]

export const FEATURES: { title: string; body: string }[] = [
  { title: 'Quality control at every station', body: 'Loops are built into the line: fix until CI is green, review until approved, deliver until merged. Nothing moves on half-finished.' },
  { title: 'Humans sign off where it matters', body: 'Approval gates after specify, plan, tasks, implement and verify. Agents ask before they merge or deploy, never after.' },
  { title: 'Raw material from your tools', body: 'Start from a Jira or Linear ticket. Confluence, GitHub, web pages and notes feed a searchable knowledge base every agent reads.' },
  { title: 'A factory that remembers', body: 'Project, team and organization memory carry your conventions and past decisions into every run, even when models change mid-line.' },
  { title: 'Secrets never leave the floor', body: 'Keys, passwords, emails and card numbers become tokens before anything reaches a model, and are put back only where agents write.' },
  { title: 'Bring your own models', body: 'Add a provider key and Spaces routes each stage to a small, medium or large model by cost and speed. No model names to maintain.' },
  { title: 'Every run on the record', body: 'Each intent keeps its documents and status history. Every tool call is a log line with the time and the agent that made it.' },
  { title: 'One tenant per organization', body: 'Teams, keys, integrations, knowledge and projects stay inside their organization. Two organizations share nothing.' },
]
