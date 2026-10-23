// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { DshCompactMarkdownText } from '../src/compat/dsh-markdown.tsx'

afterEach(cleanup)

describe('Official DSH Markdown compatibility', () => {
  it('renders remote bodies and localized code controls on the installed host', () => {
    const { container } = render(<DshCompactMarkdownText
      text={'**Review** [details](https://github.com/owner/repo)\n\n```text\nhello\n```'}
      labels={{ code: { copyLabel: 'Copy snippet', copiedLabel: 'Snippet copied' }, footnotes: 'Notes' }}
    />)
    expect(screen.getByText('Review').tagName).toBe('STRONG')
    expect(screen.getByRole('link', { name: 'details' }).getAttribute('href')).toBe('https://github.com/owner/repo')
    expect(screen.getByRole('button', { name: 'Copy snippet' })).toBeDefined()
    expect(container.querySelector('pre')?.textContent).toContain('hello')
  })
})
