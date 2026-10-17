/**
 * Public landing page: what signed-out visitors see at `/`.
 *
 * Positions Spaces as an AI software factory — work goes in as tickets and
 * ideas, moves down an assembly line of agent-run stations with human gates,
 * and comes out as reviewed, tested pull requests. "Sign in" and "Get started"
 * hand over to the sign-in screen in the matching mode.
 */

import { useEffect } from 'react'
import { FactoryAnimation } from './landing-animation'
import { WaitlistForm } from './landing-waitlist'
import { DOCS_URL, FEATURES, LEDE, REPO_URL, STATIONS, SUMMARY, TAGLINE } from '../lib/landing-content'

/** Invite only (no OPEN_REGISTRATION): the calls to action lead to the waitlist instead of sign-up. */
export function LandingPage({ openRegistration, onSignIn, onGetStarted }: { openRegistration: boolean; onSignIn: () => void; onGetStarted: () => void }) {
  // Arriving at /#waitlist (from the sign-in screen): the section exists only once rendered.
  useEffect(() => {
    if (window.location.hash === '#waitlist') document.getElementById('waitlist')?.scrollIntoView({ block: 'center' })
  }, [])
  const toWaitlist = () => {
    document.getElementById('waitlist')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    window.setTimeout(() => document.querySelector<HTMLInputElement>('#waitlist input[type=email]')?.focus({ preventScroll: true }), 400)
  }
  const getStarted = openRegistration ? onGetStarted : toWaitlist
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
          <h1>{TAGLINE}</h1>
          <p className="landing-lede">{LEDE}</p>
          <p className="landing-sub">{SUMMARY}</p>
          <div className="landing-cta">
            <button type="button" className="primary-button" onClick={getStarted}>{openRegistration ? 'Get started' : 'Join the waitlist'}</button>
            <button type="button" className="secondary-button" onClick={onSignIn}>Sign in</button>
            <a className="link-button" href={DOCS_URL} target="_blank" rel="noreferrer">Read the docs →</a>
          </div>
          <div className="landing-shot-hero">
            <FactoryAnimation />
          </div>
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
          {openRegistration ? (
            <div className="landing-cta">
              <button type="button" className="primary-button" onClick={onGetStarted}>Open your factory</button>
              <a className="link-button" href={`${DOCS_URL}getting-started/`} target="_blank" rel="noreferrer">Self-host it →</a>
            </div>
          ) : (
            <div id="waitlist" className="landing-waitlist">
              <p className="eyebrow">Invite only, for now</p>
              <h3>Get your team on the line</h3>
              <p>We're opening Spaces to teams in small batches. Join the waitlist and we'll send you a link to set up your organization.</p>
              <WaitlistForm />
              <p className="landing-waitlist-alt">Have an account? <button type="button" className="link-button" onClick={onSignIn}>Sign in</button> · <a className="link-button" href={`${DOCS_URL}getting-started/`} target="_blank" rel="noreferrer">Self-host it →</a></p>
            </div>
          )}
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
