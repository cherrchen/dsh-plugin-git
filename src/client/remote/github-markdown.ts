/** GitHub-flavored HTML-in-markdown normalization: turns the small tag subset GitHub allows in comments into readable Markdown. */

export type GitHubBlock =
  | { readonly kind: 'markdown'; readonly text: string }
  | { readonly kind: 'details'; readonly summary: string; readonly open: boolean; readonly children: readonly GitHubBlock[] }

const MARKER = '\uE000'

const PAIRED_INLINE: Record<string, [string, string]> = { b: ['**', '**'], strong: ['**', '**'], i: ['*', '*'], em: ['*', '*'], s: ['~~', '~~'], del: ['~~', '~~'], strike: ['~~', '~~'] }
const CODE_INLINE = new Set(['code', 'kbd', 'samp', 'tt'])
const UNWRAP = new Set(['span', 'sub', 'sup', 'ins', 'u', 'small', 'big', 'picture', 'font', 'g-emoji', 'abbr', 'cite', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'summary', 'details', 'li'])
const BOX = new Set(['p', 'div', 'center', 'section', 'article'])
const BLOCK_TAGS = new Set(['pre', 'blockquote', 'table', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', ...BOX])
const KNOWN = new Set([...Object.keys(PAIRED_INLINE), ...CODE_INLINE, ...UNWRAP, ...BLOCK_TAGS, 'a', 'br', 'img', 'video', 'source'])
const ALERTS: Record<string, string> = { note: '**Note**', tip: '**Tip**', important: '**Important**', warning: '**Warning**', caution: '**Caution**' }

interface Stash { readonly kind: 'raw' | 'pre'; readonly text: string }
const PLACEHOLDER = (index: number) => `${MARKER}${index}${MARKER}`
const PLACEHOLDER_RE = new RegExp(`${MARKER}(\\d+)${MARKER}`, 'g')

function entities(text: string): string {
  return text.replace(/&(nbsp|lt|gt|amp|quot|apos|#39|#[0-9]+|#[xX][0-9a-fA-F]+);/g, (all, name: string) => {
    if (name === 'nbsp') return ' '
    if (name === 'lt') return '<'
    if (name === 'gt') return '>'
    if (name === 'amp') return '&'
    if (name === 'quot') return '"'
    if (name === 'apos' || name === '#39') return '\''
    const value = name.startsWith('#x') || name.startsWith('#X') ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
    return Number.isSafeInteger(value) ? String.fromCodePoint(value) : all
  })
}

interface Tag { readonly name: string; readonly attrs: Record<string, string>; readonly closing: boolean; readonly end: number }

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const match of source.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|[^\s"'=<>`]+))?/g)) {
    attrs[match[1]!.toLowerCase()] = entities(match[3] ?? match[4] ?? match[5] ?? '')
  }
  return attrs
}

/** Read a `</name` or `<name …>` tag at `offset`; undefined when the `<` does not open an HTML-looking tag. */
function readTag(source: string, offset: number): Tag | undefined {
  const match = /^<(\/?)([A-Za-z][A-Za-z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/.exec(source.slice(offset))
  if (match === null) return undefined
  const [, slash, name, attrText] = match
  return { name: name!.toLowerCase(), attrs: parseAttrs(attrText ?? ''), closing: slash === '/', end: offset + match[0].length }
}

/** Locate the `</name>` matching the open tag whose content starts at `from`; same-name nesting counts. */
function findClose(source: string, from: number, name: string): { start: number; end: number } | undefined {
  const pattern = new RegExp(`<\\/?${name}\\b(?:"[^"]*"|'[^']*'|[^'">])*>`, 'gi')
  pattern.lastIndex = from
  let depth = 0
  for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
    if (match[0].startsWith('</')) {
      if (depth === 0) return { start: match.index, end: match.index + match[0].length }
      depth -= 1
    } else if (!/\/\s*>$/.test(match[0])) {
      depth += 1
    }
  }
  return undefined
}

function isHttp(url: string): boolean { return /^https?:\/\//i.test(url) }
function linkable(url: string): boolean { return isHttp(url) || /^mailto:/i.test(url) }

function codeSpan(text: string): string {
  let fence = '`'
  while (text.includes(fence)) fence += '`'
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : ''
  return `${fence}${pad}${text}${pad}${fence}`
}

/** Collapse the blank lines block wrappers create and trim the segment. */
function tidy(text: string): string {
  return text.replace(/\n[ \t]+(?=\n)/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

class Converter {
  constructor(private readonly stash: readonly Stash[]) {}

  /** Convert a segment without `<details>`; code/pre stay as placeholders for later verbatim restore. */
  render(source: string): string {
    let out = ''
    let index = 0
    while (index < source.length) {
      const tag = source[index] === '<' ? readTag(source, index) : undefined
      if (tag === undefined) {
        out += source[index]
        index += 1
        continue
      }
      const start = index
      index = tag.end
      const name = tag.name
      if (!KNOWN.has(name)) { out += source.slice(start, tag.end); continue }
      if (tag.closing) continue
      if (PAIRED_INLINE[name] !== undefined) {
        const close = findClose(source, index, name)
        const inner = close === undefined ? source.slice(index) : source.slice(index, close.start)
        const [open, shut] = PAIRED_INLINE[name]
        out += open + this.render(inner) + shut
        index = close === undefined ? source.length : close.end
        continue
      }
      if (CODE_INLINE.has(name)) {
        const close = findClose(source, index, name)
        const inner = (close === undefined ? source.slice(index) : source.slice(index, close.start))
          .replace(PLACEHOLDER_RE, (_, n: string) => this.stash[Number(n)]?.text ?? '')
        out += codeSpan(entities(inner.replace(/<[^>]*>/g, '')))
        index = close === undefined ? source.length : close.end
        continue
      }
      if (name === 'br') {
        const lineStart = source.lastIndexOf('\n', start - 1) + 1
        out += source.slice(lineStart, start).trimStart().startsWith('|') ? ' ' : '\n'
        continue
      }
      if (name === 'img') {
        const src = tag.attrs['src'] ?? ''
        const alt = tag.attrs['alt'] ?? ''
        if (isHttp(src)) out += `![${alt}](${src})`
        else if (alt !== '') out += alt
        continue
      }
      if (name === 'video' || name === 'source') {
        const src = tag.attrs['src'] ?? ''
        if (isHttp(src)) out += `[${src}](${src})`
        continue
      }
      if (name === 'a') {
        const close = findClose(source, index, 'a')
        if (close === undefined) continue
        const inner = this.render(source.slice(index, close.start))
        const href = tag.attrs['href'] ?? ''
        if (inner.trim() !== '') out += href !== '' && linkable(href) ? `[${inner}](${href})` : inner
        index = close.end
        continue
      }
      if (name === 'hr') { out += '\n\n---\n\n'; continue }
      if (name === 'blockquote') {
        const close = findClose(source, index, 'blockquote')
        const inner = close === undefined ? source.slice(index) : source.slice(index, close.start)
        out += this.quote(this.render(inner))
        index = close === undefined ? source.length : close.end
        continue
      }
      if (name === 'ul' || name === 'ol') {
        const close = findClose(source, index, name)
        const inner = close === undefined ? source.slice(index) : source.slice(index, close.start)
        out += this.list(inner, name === 'ol')
        index = close === undefined ? source.length : close.end
        continue
      }
      if (name === 'table') {
        const close = findClose(source, index, 'table')
        const inner = close === undefined ? source.slice(index) : source.slice(index, close.start)
        out += this.table(inner)
        index = close === undefined ? source.length : close.end
        continue
      }
      const heading = /^h([1-6])$/.exec(name)
      if (heading !== null) {
        const close = findClose(source, index, name)
        const inner = close === undefined ? source.slice(index) : source.slice(index, close.start)
        out += `\n\n${'#'.repeat(Number(heading[1]))} ${this.render(inner).trim()}\n\n`
        index = close === undefined ? source.length : close.end
        continue
      }
      if (BOX.has(name)) {
        const close = findClose(source, index, name)
        const inner = close === undefined ? source.slice(index) : source.slice(index, close.start)
        out += `\n\n${this.render(inner)}\n\n`
        index = close === undefined ? source.length : close.end
        continue
      }
      // Remaining KNOWN names unwrap: the tag drops away and content renders through.
    }
    return out
  }

  preBlock(inner: string): string {
    const body = entities(inner.replace(/<\/?code\b[^>]*>/gi, '').replace(/^\n/, '').replace(/\s+$/, ''))
    let fence = '```'
    while (body.includes(fence)) fence += '`'
    return `\n\n${fence}\n${body}\n${fence}\n\n`
  }

  private quote(inner: string): string {
    const lines = inner.trim().split('\n')
    let first = lines[0] ?? ''
    const alert = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(first)
    if (alert !== null) {
      const rest = first.slice(alert[0].length).trimStart()
      first = ALERTS[alert[1]!.toLowerCase()]! + (rest === '' ? '' : ` ${rest}`)
    }
    return `\n\n${[first, ...lines.slice(1)].map(line => `> ${line}`).join('\n')}\n\n`
  }

  private list(inner: string, ordered: boolean): string {
    const items: string[] = []
    let depth = 0
    let current: number | undefined
    for (const match of inner.matchAll(/<\/?(?:ul|ol|li)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
      const closing = match[0].startsWith('</')
      if (/^<\/?(ul|ol)/i.test(match[0])) depth += closing ? -1 : 1
      else if (!closing && depth === 0) {
        if (current !== undefined) items.push(inner.slice(current, match.index))
        current = match.index + match[0].length
      }
    }
    if (current !== undefined) items.push(inner.slice(current))
    if (items.length === 0) return `\n\n${this.render(inner)}\n\n`
    const lines = items.map((item, i) => {
      const body = this.render(item.replace(/<\/li>\s*$/i, '')).trim()
      const prefix = ordered ? `${i + 1}. ` : '- '
      return prefix + body.replace(/\n/g, '\n' + ' '.repeat(prefix.length))
    })
    return `\n\n${lines.join('\n')}\n\n`
  }

  private table(inner: string): string {
    const rows: string[][] = []
    let start: number | undefined
    const flushRow = (end: number) => {
      const rowText = inner.slice(start, end)
      const row: string[] = []
      for (const cell of rowText.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)) {
        row.push(this.render(cell[1]!.replace(/<br\s*\/?\s*>/gi, ' ')).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim())
      }
      if (row.length > 0) rows.push(row)
    }
    for (const match of inner.matchAll(/<tr\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
      if (start !== undefined) flushRow(match.index)
      start = match.index + match[0].length
    }
    if (start !== undefined) flushRow(inner.length)
    if (rows.length === 0) {
      const loose = inner.match(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi) ?? []
      const lines = (loose.length > 0 ? loose : [inner])
        .map(chunk => this.render(chunk.replace(/<\/?t[dh]\b[^>]*>/gi, '')).trim())
        .filter(line => line !== '')
      return `\n\n${lines.join('\n')}\n\n`
    }
    const width = Math.max(...rows.map(row => row.length))
    const [header, ...body] = rows.map(row => [...row, ...Array<string>(width - row.length).fill('')])
    const lines = [`| ${header!.join(' | ')} |`, `| ${header!.map(() => '---').join(' | ')} |`, ...body.map(row => `| ${row.join(' | ')} |`)]
    return `\n\n${lines.join('\n')}\n\n`
  }
}

/** Mask fenced code blocks and inline code spans so HTML passes never touch them. */
function protect(source: string): { text: string; stash: Stash[] } {
  const stash: Stash[] = []
  const lines = source.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]!)
    if (open !== null) {
      const fence = open[1]!
      const block = [lines[i]!]
      i += 1
      for (; i < lines.length; i += 1) {
        block.push(lines[i]!)
        if (new RegExp(`^ {0,3}${fence[0]}{${fence.length},}[ \t]*$`).test(lines[i]!)) break
      }
      stash.push({ kind: 'raw', text: block.join('\n') })
      out.push(PLACEHOLDER(stash.length - 1))
      continue
    }
    out.push(lines[i]!.replace(/(`+)[\s\S]*?\1/g, span => {
      stash.push({ kind: 'raw', text: span })
      return PLACEHOLDER(stash.length - 1)
    }))
  }
  return { text: out.join('\n'), stash }
}

/** Strip `<!-- … -->` comments; an unterminated comment runs to the end. */
function stripComments(source: string): string {
  return source.replace(/<!--[\s\S]*?(?:-->|$)/g, '')
}

/** Pair `<pre>` regions into stash entries so the details scan never sees markup inside them. */
function protectPre(source: string, stash: Stash[]): string {
  let out = ''
  let index = 0
  for (;;) {
    const open = /<pre\b(?:"[^"]*"|'[^']*'|[^'">])*>/i.exec(source.slice(index))
    if (open === null) { out += source.slice(index); break }
    const start = index + open.index
    const tag = readTag(source, start)!
    const close = findClose(source, tag.end, 'pre')
    out += source.slice(index, start)
    const inner = close === undefined ? source.slice(tag.end) : source.slice(tag.end, close.start)
    stash.push({ kind: 'pre', text: inner })
    out += `\n\n${PLACEHOLDER(stash.length - 1)}\n\n`
    index = close === undefined ? source.length : close.end
  }
  return out
}

export function githubBlocks(source: string): readonly GitHubBlock[] {
  const normalized = source.replace(/\r\n?/g, '\n')
  const { text, stash } = protect(normalized)
  const masked = protectPre(stripComments(text), stash)
  return parseBlocks(masked, stash)
}

function parseBlocks(source: string, stash: readonly Stash[]): GitHubBlock[] {
  const blocks: GitHubBlock[] = []
  const converter = new Converter(stash)
  const markdown = (text: string) => {
    const rendered = tidy(converter.render(text)).replace(PLACEHOLDER_RE, (_, n: string) => {
      const entry = stash[Number(n)]
      return entry === undefined ? '' : entry.kind === 'pre' ? converter.preBlock(entry.text) : entry.text
    }).trim()
    if (rendered !== '') blocks.push({ kind: 'markdown', text: rendered })
  }
  let rest = source
  for (;;) {
    const open = /<details\b(?:"[^"]*"|'[^']*'|[^'">])*>/i.exec(rest)
    if (open === null) { markdown(rest); break }
    markdown(rest.slice(0, open.index))
    const tag = readTag(rest, open.index)!
    const close = findClose(rest, tag.end, 'details')
    const inner = close === undefined ? rest.slice(tag.end) : rest.slice(tag.end, close.start)
    rest = close === undefined ? '' : rest.slice(close.end)
    let summary = ''
    let content = inner
    const sm = /<summary\b(?:"[^"]*"|'[^']*'|[^'">])*>/i.exec(inner)
    if (sm !== null) {
      const stag = readTag(inner, sm.index)!
      const sclose = findClose(inner, stag.end, 'summary')
      const sInner = sclose === undefined ? inner.slice(stag.end) : inner.slice(stag.end, sclose.start)
      summary = tidy(converter.render(sInner)).replace(PLACEHOLDER_RE, (_, n: string) => stash[Number(n)]?.text ?? '')
      content = inner.slice(0, sm.index) + (sclose === undefined ? '' : inner.slice(sclose.end))
    }
    blocks.push({ kind: 'details', summary, open: tag.attrs['open'] !== undefined, children: parseBlocks(content, stash) })
  }
  return blocks
}
