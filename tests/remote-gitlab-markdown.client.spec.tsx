// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { GitLabMarkdown } from '../src/client/remote/GitLabMarkdown.tsx'
const instance = 'https://git.example.com/gitlab'
afterEach(cleanup)
describe('GitLab safe Markdown projection', () => {
  it('renders the shared Markdown subset and only validated links', () => {
    const { container } = render(<GitLabMarkdown instance={instance} detailsLabel="Details" text={'**bold** and *emphasis*\n\n[local](/gitlab/group/repo) [outside](https://evil.example/a) [bad](javascript:alert(1)) [ref][r]\n\n[r]: https://git.example.com/gitlab/group/repo/-/issues/1\n\n![tracking](https://evil.example/track)'} />)
    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.getByRole('link', { name: 'local' }).getAttribute('href')).toBe('https://git.example.com/gitlab/group/repo')
    expect(screen.getByRole('link', { name: 'ref' }).getAttribute('href')).toBe('https://git.example.com/gitlab/group/repo/-/issues/1')
    expect(screen.queryByRole('link', { name: 'outside' })).toBeNull()
    expect(screen.queryByRole('link', { name: 'bad' })).toBeNull()
    expect(container.querySelector('img')).toBeNull(); expect(screen.getByText('tracking')).not.toBeNull()
  })
  it('keeps HTML and unknown GitLab markup as readable text and never executes it', () => {
    const { container } = render(<GitLabMarkdown instance={instance} detailsLabel="Details" text={'<img src=x onerror=alert(1)>\n\n<custom data-x="1">unknown</custom>\n\n[escape](https://git.example.com/gitlab/%2foutside)\n\n[entity](java&#x73;cript:alert(1))'} />)
    expect(container.querySelector('img, custom, script')).toBeNull()
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
    expect(container.textContent).toContain('<custom data-x="1">unknown</custom>')
    expect(container.querySelectorAll('a')).toHaveLength(0)
  })
  it('opens safe disclosure markup without interpreting its contents as HTML', () => {
    const { container } = render(<GitLabMarkdown instance={instance} detailsLabel="Details" text={'<details>\n<summary>More</summary>\n\n**hidden**\n\n<img src=x onerror=alert(1)>\n</details>'} />)
    const disclosure = container.querySelector('details')
    expect(disclosure?.querySelector('summary')?.textContent).toContain('More')
    expect(disclosure?.textContent).toContain('hidden')
    expect(container.querySelector('img')).toBeNull()
  })
})
