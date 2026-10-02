/**
 * Public landing page: what signed-out visitors see at `/`.
 *
 * Positions Spaces as an AI software factory — work goes in as tickets and
 * ideas, moves down an assembly line of agent-run stations with human gates,
 * and comes out as reviewed, tested pull requests. "Sign in" and "Get started"
 * hand over to the sign-in screen in the matching mode.
 */

const DOCS_URL = 'https://rayedbajwa.github.io/spaces/'
const REPO_URL = 'https://github.com/rayedbajwa/spaces'

interface Station { name: string; does: string; gate?: boolean }

const STATIONS: Station[] = [
  { name: 'Research', does: 'Clones the repositories the work needs, learns them and loads your knowledge base.' },
  { name: 'Specify', does: 'Turns the ticket or idea into a specification with acceptance criteria.', gate: true },
  { name: 'Plan', does: 'Chooses the approach, the repositories touched and the workstreams.', gate: true },
  { name: 'Tasks', does: 'Breaks the plan into ordered, testable tasks per repository.', gate: true },
  { name: 'Implement', does: 'Writes the code, runs the tests, fixes lint and CI, opens the pull requests.', gate: true },
  { name: 'Review', does: 'Reviews the code and loops with implement until it is approved.' },
  { name: 'Verify', does: 'Tests the affected flows end to end, in a real browser when needed.', gate: true },
  { name: 'Deliver', does: 'Drives CI, merge, deploy and UAT, and asks before it merges or deploys.' },
]

const FEATURES: { title: string; body: string }[] = [
  { title: 'Quality control at every station', body: 'Loops are built into the line: fix until CI is green, review until approved, deliver until merged. Nothing moves on half-finished.' },
  { title: 'Humans sign off where it matters', body: 'Approval gates after specify, plan, tasks, implement and verify. Agents ask before they merge or deploy, never after.' },
  { title: 'Raw material from your tools', body: 'Start from a Jira or Linear ticket. Confluence, GitHub, web pages and notes feed a searchable knowledge base every agent reads.' },
  { title: 'A factory that remembers', body: 'Project, team and organization memory carry your conventions and past decisions into every run, even when models change mid-line.' },
  { title: 'Secrets never leave the floor', body: 'Keys, passwords, emails and card numbers become tokens before anything reaches a model, and are put back only where agents write.' },
  { title: 'Bring your own models', body: 'Add a provider key and Spaces routes each stage to a small, medium or large model by cost and speed. No model names to maintain.' },
  { title: 'Every run on the record', body: 'Each intent keeps its documents and status history. Every tool call is a log line with the time and the agent that made it.' },
  { title: 'One tenant per organization', body: 'Teams, keys, integrations, knowledge and projects stay inside their organization. Two organizations share nothing.' },
]

export function LandingPage({ onSignIn, onGetStarted }: { onSignIn: () => void; onGetStarted: () => void }) {
  return (
    <div className="landing">
      <header className="landing-nav">
        <a className="landing-brand" href="/"><span className="landing-mark" aria-hidden="true" />Spaces</a>
        <nav className="landing-links">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href={DOCS_URL} target="_blank" rel="noreferrer">Docs</a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
        </nav>
        <button type="button" className="secondary-button" onClick={onSignIn}>Sign in</button>
      </header>

      <main>
        <section className="landing-hero">
          <p className="eyebrow">AI software factory</p>
          <h1>The AI software factory for your team.</h1>
          <p className="landing-lede">Specs go in, reviewed and tested pull requests come out.</p>
          <p className="landing-sub">
            Spaces runs every feature down an assembly line of specialised agents that know your codebase, your
            conventions and the tickets behind the work. You approve at the gates; the factory does the rest.
          </p>
          <div className="landing-cta">
            <button type="button" className="primary-button" onClick={onGetStarted}>Get started</button>
            <button type="button" className="secondary-button" onClick={onSignIn}>Sign in</button>
            <a className="link-button" href={DOCS_URL} target="_blank" rel="noreferrer">Read the docs →</a>
          </div>
          <figure className="landing-shot landing-shot-hero">
            <img src="/screenshots/board.png" alt="The Spaces board: every feature is a card moving through the lanes of the line" />
          </figure>
        </section>

        <section className="landing-section" id="how">
          <p className="eyebrow">How it works</p>
          <h2>From ticket to merged pull request</h2>
          <div className="landing-flow">
            <div className="landing-flow-step card">
              <span className="landing-flow-label">In</span>
              <h3>Raw material</h3>
              <ul>
                <li>A Jira or Linear ticket</li>
                <li>A Confluence page or a GitHub issue</li>
                <li>An idea in plain words</li>
              </ul>
            </div>
            <div className="landing-flow-step card">
              <span className="landing-flow-label">Line</span>
              <h3>The assembly line</h3>
              <ul>
                <li>Eight stations, each run by an agent with one job</li>
                <li>Human gates between the stations that matter</li>
                <li>Pipelines you can reshape in YAML</li>
              </ul>
            </div>
            <div className="landing-flow-step card">
              <span className="landing-flow-label">Out</span>
              <h3>Finished goods</h3>
              <ul>
                <li>A branch and a Conventional-Commits PR per workstream</li>
                <li>Green CI, code review and QA done</li>
                <li>Merged and deployed, with the spec alongside the code</li>
              </ul>
            </div>
          </div>

          <ol className="landing-stations">
            {STATIONS.map((s, i) => (
              <li key={s.name} className="landing-station">
                <span className="landing-station-num">{String(i + 1).padStart(2, '0')}</span>
                <div>
                  <h3>{s.name}{s.gate && <span className="landing-gate">Human gate</span>}</h3>
                  <p>{s.does}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="landing-section" id="features">
          <p className="eyebrow">Features</p>
          <h2>Built to run like a factory floor</h2>
          <div className="landing-features">
            {FEATURES.map((f) => (
              <div key={f.title} className="landing-feature card">
                <h3>{f.title}</h3>
                <p>{f.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="landing-section">
          <p className="eyebrow">On the floor</p>
          <h2>Watch every station work</h2>
          <div className="landing-gallery">
            <figure className="landing-shot">
              <img src="/screenshots/project-page.png" alt="A project page with its lane, run and verification status" loading="lazy" />
              <figcaption>Each project has its own page: lane, run, verification and repositories at a glance.</figcaption>
            </figure>
            <figure className="landing-shot">
              <img src="/screenshots/agent-output.png" alt="Live agent output with stage progress and tool calls" loading="lazy" />
              <figcaption>Live agent output, stage by stage, with approvals and answers inline.</figcaption>
            </figure>
            <figure className="landing-shot">
              <img src="/screenshots/generated-spec.png" alt="A specification written by the specify stage" loading="lazy" />
              <figcaption>Every station leaves an artifact you can read, approve or send back.</figcaption>
            </figure>
          </div>
        </section>

        <section className="landing-section landing-closing card">
          <h2>Not a code generator you fire and forget</h2>
          <p>
            Spaces is a production line with inspection points. Every station leaves an artifact you can read,
            every gate waits for a person, and every run can be paused, resumed or sent back.
          </p>
          <div className="landing-cta">
            <button type="button" className="primary-button" onClick={onGetStarted}>Open your factory</button>
            <a className="link-button" href={`${DOCS_URL}getting-started/`} target="_blank" rel="noreferrer">Self-host it →</a>
          </div>
        </section>
      </main>

      <footer className="landing-footer">
        <span>Spaces · the AI software factory · source-available</span>
        <span className="landing-footer-links">
          <a href={DOCS_URL} target="_blank" rel="noreferrer">Docs</a>
          <a href={REPO_URL} target="_blank" rel="noreferrer">GitHub</a>
        </span>
      </footer>
    </div>
  )
}
