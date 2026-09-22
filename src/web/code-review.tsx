import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import { json } from './auth'
import { anchorKey, commentAnchor, parsePatch, type DiffLine, type DiffSide } from '../lib/diff-parse'

/**
 * Code review tab (project page).
 *
 *  Pull requests  every PR the feature opened, with CI, GitHub review state
 *                 and the decision recorded in Spaces for its current commit.
 *  Diff           the selected PR's files as unified diffs, with existing
 *                 review comments inline; click a line's + to draft a comment.
 *  Review         Approve, Request changes or Comment. The review goes to
 *                 GitHub with the drafts as inline comments, and approve /
 *                 request changes become the feature's code review status, so
 *                 the pipeline moves on to deliver or back to implement.
 */

interface TrackedPullRequest {
  githubRepo: string
  number: number
  url: string
  title: string
  head: string
  headSha: string
  base: string
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  review: string
  checks: string
  mergeable?: boolean | null
  stackedOn?: string
}

interface DraftComment { path: string; line: number; side: DiffSide; body: string }

interface RecordedDecision {
  githubRepo: string
  number: number
  decision: 'approved' | 'changes_requested'
  reviewer: string
  at: string
  headSha: string
  summary: string
  comments: DraftComment[]
}

interface ListResponse {
  pullRequests: TrackedPullRequest[]
  decisions: RecordedDecision[]
  overall: 'approved' | 'changes_requested' | null
  feature?: string
  reason?: string
}

interface ReviewFile { filename: string; previousFilename?: string; status: string; additions: number; deletions: number; patch?: string; blobUrl?: string }
interface ReviewComment { id: number; path: string; line: number | null; side: DiffSide; originalLine: number | null; body: string; author: string; createdAt: string; inReplyTo?: number; url: string }
interface ReviewSummary { author: string; state: string; body: string; submittedAt: string; url?: string }

interface PullRequestDetail {
  githubRepo: string
  number: number
  title: string
  body: string
  url: string
  author: string
  head: string
  base: string
  headSha: string
  state: 'open' | 'closed'
  merged: boolean
  draft: boolean
  additions: number
  deletions: number
  changedFiles: number
  files: ReviewFile[]
  filesTruncated: boolean
  comments: ReviewComment[]
  reviews: ReviewSummary[]
}

type NextStep = { step: string; label: string; reason: string }

const LARGE_FILE_LINES = 800

function prKey(pr: { githubRepo: string; number: number }): string {
  return `${pr.githubRepo}#${pr.number}`
}

function prPath(namespace: string, pr: { githubRepo: string; number: number }): string {
  return `/api/projects/${encodeURIComponent(namespace)}/pull-requests/${pr.githubRepo}/${pr.number}`
}

function badgeClass(value: string): string {
  if (['approved', 'success', 'merged'].includes(value)) return 'completed'
  if (['changes_requested', 'failure', 'closed'].includes(value)) return 'error'
  if (['pending', 'review_required', 'open'].includes(value)) return 'paused'
  return 'idle'
}

function fileAnchorId(filename: string): string {
  return `cr-file-${filename.replace(/[^a-zA-Z0-9]+/g, '-')}`
}

export function CodeReviewPanel({ projectNamespace, onReviewed }: { projectNamespace: string; onReviewed?: (nextStep?: NextStep) => void }) {
  const [list, setList] = useState<ListResponse | null>(null)
  const [listError, setListError] = useState('')
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<PullRequestDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [drafts, setDrafts] = useState<DraftComment[]>([])
  const [composer, setComposer] = useState<{ path: string; line: number; side: DiffSide } | null>(null)
  const [composerText, setComposerText] = useState('')
  const [summary, setSummary] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const loadList = useCallback(async () => {
    setListError('')
    try {
      const data = await json<ListResponse>(`/api/projects/${encodeURIComponent(projectNamespace)}/pull-requests`)
      setList(data)
      setSelected((current) => {
        if (current && data.pullRequests.some((p) => prKey(p) === current)) return current
        const first = data.pullRequests.find((p) => p.state === 'open') ?? data.pullRequests[0]
        return first ? prKey(first) : ''
      })
    } catch (error) {
      setListError(error instanceof Error ? error.message : String(error))
    }
  }, [projectNamespace])

  const selectedPr = list?.pullRequests.find((p) => prKey(p) === selected)

  const loadDetail = useCallback(async (pr: TrackedPullRequest) => {
    setLoadingDetail(true)
    setDetailError('')
    try {
      const data = await json<PullRequestDetail>(prPath(projectNamespace, pr))
      setDetail(data)
      setCollapsed(new Set(data.files.filter((f) => (f.patch?.split('\n').length ?? 0) > LARGE_FILE_LINES || f.status === 'removed').map((f) => f.filename)))
    } catch (error) {
      setDetail(null)
      setDetailError(error instanceof Error ? error.message : String(error))
    } finally {
      setLoadingDetail(false)
    }
  }, [projectNamespace])

  useEffect(() => { void loadList() }, [loadList])
  useEffect(() => {
    setDrafts([])
    setComposer(null)
    setSummary('')
    setMessage('')
    if (selectedPr) void loadDetail(selectedPr)
    else setDetail(null)
    // Reload only when the selection changes, not on every list refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, loadDetail])

  const commentsByAnchor = useMemo(() => {
    const map = new Map<string, ReviewComment[]>()
    for (const c of detail?.comments ?? []) {
      if (c.line === null) continue
      const key = anchorKey(c.path, c.side, c.line)
      map.set(key, [...(map.get(key) ?? []), c])
    }
    return map
  }, [detail])

  const decisionFor = (pr: TrackedPullRequest) => list?.decisions.find((d) => d.githubRepo === pr.githubRepo && d.number === pr.number)
  const reviewable = Boolean(detail && detail.state === 'open')

  function saveDraft() {
    if (!composer || !composerText.trim()) return
    setDrafts((current) => [...current, { ...composer, body: composerText.trim() }])
    setComposer(null)
    setComposerText('')
  }

  async function submit(event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT') {
    if (!detail || !selectedPr) return
    if (event !== 'APPROVE' && !summary.trim() && drafts.length === 0) {
      setMessage('Add a summary or at least one inline comment first.')
      return
    }
    setSubmitting(true)
    setMessage('')
    try {
      const result = await json<{ postedAs: string; url?: string; overall: string | null; nextStep?: NextStep }>(`${prPath(projectNamespace, selectedPr)}/review`, {
        method: 'POST',
        body: JSON.stringify({ event, summary, comments: drafts, headSha: detail.headSha }),
      })
      const verdict = event === 'APPROVE' ? 'Approved' : event === 'REQUEST_CHANGES' ? 'Changes requested' : 'Comments posted'
      const asComment = result.postedAs !== event
        ? ' GitHub does not let a pull request’s author approve or block it, so it was posted as a comment naming your decision.'
        : ''
      const pipeline = result.overall === 'approved'
        ? ' Every open pull request is approved: the feature moves on to deliver.'
        : result.overall === 'changes_requested'
          ? ' The feature goes back to implement with your comments as findings.'
          : event === 'COMMENT' ? '' : ' Other pull requests of this feature still need a decision.'
      setMessage(`${verdict}.${asComment}${pipeline}`)
      setDrafts([])
      setSummary('')
      await Promise.all([loadList(), loadDetail(selectedPr)])
      onReviewed?.(result.nextStep)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error))
    } finally {
      setSubmitting(false)
    }
  }

  if (listError) {
    return (
      <section className="card panel slim-panel">
        <p className="error-text">Could not load pull requests: {listError}</p>
        <button className="secondary-button" onClick={() => void loadList()} type="button">Try again</button>
      </section>
    )
  }
  if (!list) return <section className="card panel slim-panel"><p className="empty-state">Loading pull requests…</p></section>
  if (list.pullRequests.length === 0) {
    return (
      <section className="card panel slim-panel">
        <h3>Code review</h3>
        <p className="empty-state">{list.reason ?? 'No pull request is open for this feature yet. Implement publishes one to the project repository when it commits.'}</p>
        <button className="secondary-button" onClick={() => void loadList()} type="button">Refresh</button>
      </section>
    )
  }

  return (
    <section className="card panel code-review">
      <div className="cr-toolbar">
        <div>
          <h3>Code review{list.feature ? ` · ${list.feature}` : ''}</h3>
          <p className="panel-subtitle">
            {list.overall === 'approved' ? 'Every open pull request is approved in Spaces for its latest commit.'
              : list.overall === 'changes_requested' ? 'Changes were requested; the feature goes back to implement.'
              : 'Review each open pull request. Approving all of them moves the feature on to deliver.'}
          </p>
        </div>
        <button className="secondary-button" onClick={() => { void loadList(); if (selectedPr) void loadDetail(selectedPr) }} type="button">Refresh</button>
      </div>

      <div className="cr-pr-list" role="tablist">
        {list.pullRequests.map((pr) => {
          const decision = decisionFor(pr)
          const current = decision && decision.headSha === pr.headSha
          return (
            <button key={prKey(pr)} className={`cr-pr ${prKey(pr) === selected ? 'active' : ''}`} onClick={() => setSelected(prKey(pr))} type="button" role="tab" aria-selected={prKey(pr) === selected}>
              <span className="cr-pr-title"><strong>{pr.githubRepo}#{pr.number}</strong> {pr.title}</span>
              <span className="cr-pr-badges">
                <span className={`mini-badge ${badgeClass(pr.merged ? 'merged' : pr.state)}`}>{pr.merged ? 'merged' : pr.draft ? 'draft' : pr.state}</span>
                {pr.state === 'open' && <span className={`mini-badge ${badgeClass(pr.checks)}`}>CI {pr.checks}</span>}
                {decision && <span className={`mini-badge ${current ? badgeClass(decision.decision) : 'idle'}`} title={current ? '' : 'Made on an earlier commit'}>{decision.decision === 'approved' ? 'approved' : 'changes requested'}{current ? '' : ' (outdated)'}</span>}
              </span>
            </button>
          )
        })}
      </div>

      {loadingDetail && <p className="empty-state">Loading the diff…</p>}
      {detailError && <p className="error-text">Could not load the pull request: {detailError}</p>}

      {detail && !loadingDetail && (
        <>
          <div className="cr-pr-header">
            <div>
              <a href={detail.url} target="_blank" rel="noreferrer"><strong>{detail.title}</strong> ↗</a>
              <p className="panel-subtitle">
                <code>{detail.head}</code> → <code>{detail.base}</code> · {detail.author} · {detail.changedFiles} file{detail.changedFiles === 1 ? '' : 's'} · <span className="cr-add">+{detail.additions}</span> <span className="cr-del">−{detail.deletions}</span> · <code>{detail.headSha.slice(0, 7)}</code>
              </p>
            </div>
          </div>

          {detail.body.trim() && (
            <details className="cr-description">
              <summary>Description</summary>
              <pre>{detail.body}</pre>
            </details>
          )}

          {detail.reviews.length > 0 && (
            <details className="cr-description">
              <summary>{detail.reviews.length} review{detail.reviews.length === 1 ? '' : 's'} on GitHub</summary>
              <ul className="cr-reviews">
                {detail.reviews.map((r, i) => (
                  <li key={i}>
                    <span className={`mini-badge ${badgeClass(r.state.toLowerCase())}`}>{r.state.toLowerCase().replace('_', ' ')}</span> <strong>{r.author}</strong> <small>{r.submittedAt ? new Date(r.submittedAt).toLocaleString() : ''}</small>
                    {r.body.trim() && <pre>{r.body}</pre>}
                  </li>
                ))}
              </ul>
            </details>
          )}

          <nav className="cr-files" aria-label="Changed files">
            {detail.files.map((f) => (
              <a key={f.filename} href={`#${fileAnchorId(f.filename)}`} onClick={() => setCollapsed((c) => { const next = new Set(c); next.delete(f.filename); return next })}>
                <span className={`cr-status cr-status-${f.status}`}>{f.status[0]!.toUpperCase()}</span>
                <span className="cr-file-name">{f.filename}</span>
                <span className="cr-add">+{f.additions}</span> <span className="cr-del">−{f.deletions}</span>
              </a>
            ))}
            {detail.filesTruncated && <p className="field-hint">Only the first {detail.files.length} files are shown. Open the pull request on GitHub for the rest.</p>}
          </nav>

          {detail.files.map((file) => {
            const isCollapsed = collapsed.has(file.filename)
            const lines = file.patch ? parsePatch(file.patch) : []
            const outdated = detail.comments.filter((c) => c.path === file.filename && c.line === null)
            return (
              <article key={file.filename} id={fileAnchorId(file.filename)} className="cr-file">
                <button className="cr-file-header" onClick={() => setCollapsed((c) => { const next = new Set(c); if (next.has(file.filename)) next.delete(file.filename); else next.add(file.filename); return next })} type="button" aria-expanded={!isCollapsed}>
                  <span>{isCollapsed ? '▸' : '▾'}</span>
                  <span className="cr-file-name">{file.previousFilename ? `${file.previousFilename} → ` : ''}{file.filename}</span>
                  <span className="cr-add">+{file.additions}</span> <span className="cr-del">−{file.deletions}</span>
                </button>
                {!isCollapsed && (
                  file.patch ? (
                    <div className="cr-diff-scroll">
                      <table className="cr-diff">
                        <tbody>
                          {lines.map((line, index) => (
                            <DiffRow
                              key={index}
                              line={line}
                              path={file.filename}
                              comments={commentsByAnchor}
                              drafts={drafts}
                              canComment={reviewable}
                              composer={composer}
                              composerText={composerText}
                              onOpenComposer={(anchor) => { setComposer(anchor); setComposerText('') }}
                              onComposerText={setComposerText}
                              onSaveDraft={saveDraft}
                              onCancelComposer={() => setComposer(null)}
                              onRemoveDraft={(draft) => setDrafts((current) => current.filter((d) => d !== draft))}
                            />
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p className="empty-state">No diff to show ({file.status === 'removed' ? 'file deleted' : 'binary or too large'}). {file.blobUrl && <a href={file.blobUrl} target="_blank" rel="noreferrer">View on GitHub ↗</a>}</p>
                  )
                )}
                {!isCollapsed && outdated.length > 0 && (
                  <div className="cr-outdated">
                    <small>Comments on lines that have since changed</small>
                    {outdated.map((c) => <CommentView key={c.id} comment={c} />)}
                  </div>
                )}
              </article>
            )
          })}

          {reviewable ? (
            <div className="cr-submit">
              <textarea value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="Overall review: what is good, what must change before this merges." rows={3} />
              <div className="button-row" style={{ alignItems: 'center' }}>
                <button className="primary-button" disabled={submitting} onClick={() => void submit('APPROVE')} type="button">Approve</button>
                <button className="danger-button" disabled={submitting} onClick={() => void submit('REQUEST_CHANGES')} type="button">Request changes</button>
                <button className="secondary-button" disabled={submitting} onClick={() => void submit('COMMENT')} type="button">Comment</button>
                <span className="field-hint" style={{ margin: 0 }}>{drafts.length ? `${drafts.length} inline comment${drafts.length === 1 ? '' : 's'} will be posted with the review.` : 'Click + beside a line to comment on it.'}</span>
              </div>
            </div>
          ) : (
            <p className="field-hint">This pull request is {detail.merged ? 'merged' : 'closed'}; the diff is read-only.</p>
          )}
          {message && <p className={/could not|error|failed|has new commits|refused/i.test(message) ? 'error-text' : 'cr-message'}>{message}</p>}
        </>
      )}
    </section>
  )
}

function CommentView({ comment }: { comment: ReviewComment }) {
  return (
    <div className="cr-comment">
      <div className="cr-comment-meta"><strong>{comment.author}</strong> <small>{new Date(comment.createdAt).toLocaleString()}</small> <a href={comment.url} target="_blank" rel="noreferrer">↗</a></div>
      <pre>{comment.body}</pre>
    </div>
  )
}

function DiffRow({
  line, path, comments, drafts, canComment, composer, composerText,
  onOpenComposer, onComposerText, onSaveDraft, onCancelComposer, onRemoveDraft,
}: {
  line: DiffLine
  path: string
  comments: Map<string, ReviewComment[]>
  drafts: DraftComment[]
  canComment: boolean
  composer: { path: string; line: number; side: DiffSide } | null
  composerText: string
  onOpenComposer: (anchor: { path: string; line: number; side: DiffSide }) => void
  onComposerText: (text: string) => void
  onSaveDraft: () => void
  onCancelComposer: () => void
  onRemoveDraft: (draft: DraftComment) => void
}) {
  if (line.kind === 'hunk') return <tr className="cr-hunk"><td colSpan={3}>{line.text}</td></tr>
  if (line.kind === 'note') return <tr className="cr-note"><td colSpan={3}>{line.text}</td></tr>
  const anchor = commentAnchor(line)
  const key = anchor ? anchorKey(path, anchor.side, anchor.line) : ''
  const existing = key ? comments.get(key) ?? [] : []
  const lineDrafts = anchor ? drafts.filter((d) => d.path === path && d.side === anchor.side && d.line === anchor.line) : []
  const composing = Boolean(anchor && composer && composer.path === path && composer.side === anchor.side && composer.line === anchor.line)
  const marker = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '
  return (
    <Fragment>
      <tr className={`cr-line cr-row-${line.kind}`}>
        <td className="cr-num">{line.oldLine ?? ''}</td>
        <td className="cr-num">
          {canComment && anchor && <button className="cr-add-comment" onClick={() => onOpenComposer({ path, ...anchor })} type="button" aria-label={`Comment on line ${anchor.line}`}>+</button>}
          {line.newLine ?? ''}
        </td>
        <td className="cr-code"><span className="cr-marker">{marker}</span>{line.text}</td>
      </tr>
      {(existing.length > 0 || lineDrafts.length > 0 || composing) && (
        <tr className="cr-thread">
          <td colSpan={3}>
            {existing.map((c) => <CommentView key={c.id} comment={c} />)}
            {lineDrafts.map((d, i) => (
              <div key={i} className="cr-comment cr-draft">
                <div className="cr-comment-meta"><span className="mini-badge paused">pending</span> <button className="link-button" onClick={() => onRemoveDraft(d)} type="button">Remove</button></div>
                <pre>{d.body}</pre>
              </div>
            ))}
            {composing && (
              <div className="cr-composer">
                <textarea autoFocus value={composerText} onChange={(e) => onComposerText(e.target.value)} rows={3} placeholder="Leave a comment on this line"
                  onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); onSaveDraft() } if (e.key === 'Escape') onCancelComposer() }} />
                <div className="button-row">
                  <button className="primary-button" disabled={!composerText.trim()} onClick={onSaveDraft} type="button">Add to review</button>
                  <button className="secondary-button" onClick={onCancelComposer} type="button">Cancel</button>
                </div>
              </div>
            )}
          </td>
        </tr>
      )}
    </Fragment>
  )
}
