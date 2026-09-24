import { describe, expect, test } from 'bun:test'
import { renderMarkdown } from '../src/web/markdown'

describe('rendering markdown', () => {
  test('task lists become check marks, not form controls; plain items stay plain', () => {
    const html = renderMarkdown('- [x] T001 [P] Add parser\n- [ ] T002 Wire it\n  - [X] nested\n- plain item\n1. [ ] numbered')
    expect(html).not.toContain('<input')
    expect(html).toContain('<li class="task-item done"><span class="task-box" role="img" aria-label="done">✓</span>T001 [P] Add parser</li>')
    expect(html).toContain('<li class="task-item"><span class="task-box" role="img" aria-label="not done"></span>T002 Wire it')
    expect(html).toContain('<li class="task-item done"><span class="task-box" role="img" aria-label="done">✓</span>nested</li>')
    expect(html).toContain('<li>plain item</li>')
    expect(html).toContain('<li class="task-item"><span class="task-box" role="img" aria-label="not done"></span>numbered</li>')
  })

  test('still strips what could execute', () => {
    const html = renderMarkdown('<script>alert(1)</script>[x](javascript:alert(1)) <img src=x onerror=alert(1)>')
    expect(html).not.toContain('<script')
    expect(html).not.toMatch(/href="javascript:/i)
    expect(html).not.toContain('onerror')
  })
})
