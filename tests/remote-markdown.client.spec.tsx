// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { githubBlocks } from '../src/client/remote/github-markdown.ts'
import { RemoteMarkdown } from '../src/client/remote/RemoteMarkdown.tsx'
import { RemoteAvatar } from '../src/client/remote/RemoteAvatar.tsx'

afterEach(cleanup)

const text = (source: string): string =>
  githubBlocks(source).map(block => block.kind === 'markdown' ? block.text : `<details:${block.summary}>`).join('\n')

describe('githubBlocks', () => {
  it('removes single-line and multi-line HTML comments', () => {
    expect(text('before <!-- hidden --> after')).toBe('before  after')
    expect(text('a\n<!-- line1\nline2 -->\nb')).toBe('a\n\nb')
  })
  it('keeps HTML inside fenced code and inline code untouched', () => {
    expect(text('```\n<details><summary>x</summary>\n```\nafter `<b>`')).toBe('```\n<details><summary>x</summary>\n```\nafter `<b>`')
    expect(text('~~~\n<!-- kept -->\n~~~')).toBe('~~~\n<!-- kept -->\n~~~')
  })
  it('turns details blocks into details entries with inline summary', () => {
    const [block] = githubBlocks('<details>\n<summary>More <b>info</b></summary>\nbody text\n</details>')
    expect(block).toMatchObject({ kind: 'details', summary: 'More **info**', open: false })
    expect(block?.kind === 'details' && block.children[0]).toEqual({ kind: 'markdown', text: 'body text' })
  })
  it('honours open, missing summary and unclosed details', () => {
    const [open] = githubBlocks('<details open>\n<summary>s</summary>\nx\n</details>')
    expect(open).toMatchObject({ open: true, summary: 's' })
    const [bare] = githubBlocks('<details>\ncontent only\n</details>')
    expect(bare).toMatchObject({ summary: '', kind: 'details' })
    const [unclosed] = githubBlocks('<details>\n<summary>s</summary>\nrest')
    expect(unclosed?.kind === 'details' && unclosed.children[0]).toEqual({ kind: 'markdown', text: 'rest' })
  })
  it('nests details inside details', () => {
    const [outer] = githubBlocks('<details>\n<summary>out</summary>\n<details>\n<summary>in</summary>\ndeep\n</details>\n</details>')
    expect(outer?.kind === 'details' && outer.children[0]).toMatchObject({ kind: 'details', summary: 'in' })
  })
  it('converts br to a newline but a space on a table row line', () => {
    expect(text('one<br>two')).toBe('one\ntwo')
    expect(text('| a<br>b | c |')).toBe('| a b | c |')
  })
  it('projects img only for http(s) sources', () => {
    expect(text('<img src="https://x/p.png" alt="pic">')).toBe('![pic](https://x/p.png)')
    expect(text('<img src="javascript:alert(1)" alt="pic">')).toBe('pic')
    expect(text('<img src="/relative.png" alt="pic">')).toBe('pic')
    expect(text('<img src="/relative.png">')).toBe('')
  })
  it('links anchors with safe hrefs and unwraps the rest', () => {
    expect(text('<a href="https://x">go</a>')).toBe('[go](https://x)')
    expect(text('<a href="mailto:a@b">mail</a>')).toBe('[mail](mailto:a@b)')
    expect(text('<a href="/rel">rel</a>')).toBe('rel')
    expect(text('<a name="x"></a>after')).toBe('after')
  })
  it('converts inline code tags with entity decoding and longer fences', () => {
    expect(text('<code>a &lt; b</code>')).toBe('`a < b`')
    expect(text('<code>has `tick`</code>')).toBe('`` has `tick` ``')
  })
  it.each(['&#1114112;', '&#x110000;', '&#X110000;', '&#9007199254740992;'])('preserves out-of-range numeric entity %s in HTML content and attributes', entity => {
    expect(text(`<code>${entity}</code>`)).toBe('`' + entity + '`')
    expect(text(`<pre><code>${entity}</code></pre>`)).toBe('```\n' + entity + '\n```')
    expect(text(`<img src="/relative.png" alt="${entity}">`)).toBe(entity)
  })
  it('decodes numeric entities at Unicode boundaries and supplementary characters', () => {
    expect(text('<code>&#0;&#65;&#128512;&#1114111;</code>')).toBe('`\u0000A😀\u{10FFFF}`')
    expect(text('<code>&#x0;&#x41;&#X1F600;&#x10FFFF;</code>')).toBe('`\u0000A😀\u{10FFFF}`')
  })
  it('leaves unknown tags such as Vec<String> literal', () => {
    expect(text('use Vec<String> and <T>')).toBe('use Vec<String> and <T>')
  })
  it('unwraps p with attributes and converts emphasis tags', () => {
    expect(text('<p align="center"><img src="https://x/i.png" alt="i"></p>')).toBe('![i](https://x/i.png)')
    expect(text('<b>b</b> <i>i</i> <s>s</s> <sub>2</sub>')).toBe('**b** *i* ~~s~~ 2')
  })
  it('converts headings, hr, blockquote alerts and pre blocks', () => {
    expect(text('<h2>T</h2>')).toBe('## T')
    expect(text('a<hr>b')).toBe('a\n\n---\n\nb')
    expect(text('<blockquote>\n[!WARNING] watch out\n</blockquote>')).toBe('> **Warning** watch out')
    expect(text('<pre><code>let x = 1;\n&lt;tag&gt;</code></pre>')).toBe('```\nlet x = 1;\n<tag>\n```')
  })
  it('converts lists and simple tables', () => {
    expect(text('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two')
    expect(text('<ol><li>one</li><li>two</li></ol>')).toBe('1. one\n2. two')
    expect(text('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'))
      .toBe('| A | B |\n| --- | --- |\n| 1 | 2 |')
  })
  it('collapses runs of blank lines', () => {
    expect(text('a\n\n\n\n\nb')).toBe('a\n\nb')
  })
  it('unwraps g-emoji and other hyphenated allowlisted tags', () => {
    expect(text('<g-emoji>🎉</g-emoji>')).toBe('🎉')
  })
  it('preserves plain markdown verbatim: nested lists, hard breaks, indented code', () => {
    const source = '- a\n  - b\n    - c\nline one  \nline two\n\n    indented code\n      still code'
    expect(text(source)).toBe(source)
  })
  it('round-trips a body with no HTML at all', () => {
    const source = '# Title\n\nSome **bold** and `code`.\n\n> a quote\n\n- item 1\n  - item 2\n\n```\nfenced <b>html</b>\n```'
    expect(text(source)).toBe(source)
  })
})

describe('RemoteMarkdown', () => {
  const labels = { code: { copyLabel: 'Copy', copiedLabel: 'Copied' }, footnotes: 'Footnotes' }
  it('renders remote bodies with out-of-range numeric entities', () => {
    const { container } = render(<RemoteMarkdown text={'before <code>&#1114112; &#x110000;</code> after'} labels={labels} detailsLabel="Details" />)
    expect(container.querySelector('code')?.textContent).toBe('&#1114112; &#x110000;')
    expect(container.textContent).toContain('before')
    expect(container.textContent).toContain('after')
  })
  it('renders details as a disclosure element without literal HTML text', () => {
    const { container } = render(
      <RemoteMarkdown text={'intro\n<details>\n<summary>More</summary>\nhidden <!--x--> body\n</details>'} labels={labels} detailsLabel="Details" />,
    )
    expect(container.querySelector('details')).not.toBeNull()
    expect(container.querySelector('summary')).not.toBeNull()
    expect(container.textContent).not.toContain('<details>')
    expect(container.textContent).not.toContain('<summary>')
    expect(container.textContent).not.toContain('<!--')
    expect(container.textContent).toContain('hidden')
  })
  it('falls back to the localized label for empty summaries', () => {
    render(<RemoteMarkdown text={'<details><summary></summary>x</details>'} labels={labels} detailsLabel="Details" />)
    expect(screen.getByText('Details')).not.toBeNull()
  })
})

describe('RemoteAvatar', () => {
  it('renders an img with the 2x size param and falls back to the login initial', () => {
    const { container, rerender } = render(<RemoteAvatar login="alice" url="https://avatars.githubusercontent.com/u/1?v=4" size={20} />)
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toBe('https://avatars.githubusercontent.com/u/1?v=4&s=40')
    expect(img.getAttribute('loading')).toBe('lazy')
    expect(img.getAttribute('referrerpolicy')).toBe('no-referrer')
    fireEvent.error(img)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('A')
    rerender(<RemoteAvatar login="bob" url={undefined} size={20} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toBe('B')
    rerender(<RemoteAvatar login={undefined} url={undefined} size={20} />)
    expect(container.textContent).toBe('?')
  })
})
