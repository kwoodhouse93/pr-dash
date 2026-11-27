export type Inline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; children: Inline[] }
  | { type: 'em'; children: Inline[] }
  | { type: 'link'; href: string; children: Inline[] }
  | { type: 'break' }

export type Block =
  | { type: 'heading'; level: 1 | 2 | 3; children: Inline[] }
  | { type: 'paragraph'; children: Inline[] }
  | { type: 'list'; ordered: boolean; items: Inline[][] }
  | { type: 'quote'; children: Inline[] }
  | { type: 'code'; text: string }
  | { type: 'table'; header: Inline[][]; rows: Inline[][][] }
  | { type: 'rule' }
  | { type: 'details'; open: boolean; summary: Inline[]; children: Block[] }

const DETAILS_SLOT = /^\uE000details:(\d+)$/
const DETAILS_OPEN = /^[ \t]*<details(\s[^>]*)?>/i

export function parseMarkdown(source: string): Block[] {
  return parseMarkdownAt(source, 0)
}

function parseMarkdownAt(source: string, depth: number): Block[] {
  const normalized = source.replace(/\r\n?/g, '\n')
  if (depth > 8) return parseBlocks(stripLooseDetailsTags(normalized), [])
  const { text, slots } = liftDetails(normalized, depth)
  return parseBlocks(text, slots)
}

function parseBlocks(source: string, slots: Block[]): Block[] {
  const lines = source.split('\n')
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    const slot = DETAILS_SLOT.exec(line.trim())
    if (slot) {
      const block = slots[Number(slot[1])]
      if (block) blocks.push(block)
      index += 1
      continue
    }
    if (line.trim() === '') {
      index += 1
      continue
    }
    if (line.startsWith('```')) {
      const body: string[] = []
      index += 1
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        body.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) index += 1
      blocks.push({ type: 'code', text: body.join('\n') })
      continue
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line)
    if (heading) {
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3
      blocks.push({ type: 'heading', level, children: parseInlines(heading[2] ?? '') })
      index += 1
      continue
    }
    if (isRule(line)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }
    if (isTableStart(lines, index)) {
      const header = splitRow(line)
      index += 2
      const rows: string[][] = []
      while (index < lines.length && isTableRow(lines[index] ?? '')) {
        rows.push(splitRow(lines[index] ?? ''))
        index += 1
      }
      blocks.push({
        type: 'table',
        header: header.map((cell) => parseInlines(cell)),
        rows: rows.map((row) => row.map((cell) => parseInlines(cell))),
      })
      continue
    }
    const item = listItem(line)
    if (item) {
      const ordered = item.ordered
      const items: Inline[][] = []
      while (index < lines.length) {
        const next = listItem(lines[index] ?? '')
        if (!next || next.ordered !== ordered) break
        let text = next.text
        index += 1
        while (index < lines.length && isListContinuation(lines[index] ?? '')) {
          text += ` ${(lines[index] ?? '').trim()}`
          index += 1
        }
        items.push(parseInlines(text))
      }
      blocks.push({ type: 'list', ordered, items })
      continue
    }
    if (line.startsWith('>')) {
      const parts: string[] = []
      while (index < lines.length && (lines[index] ?? '').startsWith('>')) {
        parts.push((lines[index] ?? '').replace(/^>\s?/, ''))
        index += 1
      }
      blocks.push({ type: 'quote', children: parseInlines(parts.join(' ')) })
      continue
    }
    const parts: string[] = []
    while (index < lines.length && !startsBlock(lines, index)) {
      parts.push(lines[index] ?? '')
      index += 1
    }
    const children = parseInlines(joinParagraph(parts))
    if (children.length) blocks.push({ type: 'paragraph', children })
  }
  return blocks
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] ?? ''
  if (line.trim() === '') return true
  if (DETAILS_SLOT.test(line.trim())) return true
  if (line.startsWith('```') || line.startsWith('>')) return true
  if (/^(#{1,6})\s+/.test(line) || isRule(line) || listItem(line) || isTableStart(lines, index)) return true
  return false
}

function liftDetails(source: string, depth: number): { text: string; slots: Block[] } {
  const slots: Block[] = []
  const lines = source.split('\n')
  const out: string[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.startsWith('```')) {
      out.push(line)
      index += 1
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        out.push(lines[index] ?? '')
        index += 1
      }
      if (index < lines.length) {
        out.push(lines[index] ?? '')
        index += 1
      }
      continue
    }
    if (DETAILS_OPEN.test(line)) {
      const rest = lines.slice(index).join('\n')
      const taken = consumeDetails(rest)
      if (taken) {
        const { summary, body } = splitSummary(taken.inner)
        slots.push({
          type: 'details',
          open: taken.open,
          summary: parseInlines(plainSummary(summary)),
          children: parseMarkdownAt(body.trim(), depth + 1),
        })
        out.push(`\uE000details:${slots.length - 1}`)
        const parts = rest.slice(0, taken.length).split('\n')
        const lastIndex = index + parts.length - 1
        const after = (lines[lastIndex] ?? '').slice((parts.at(-1) ?? '').length)
        if (after.trim()) {
          lines[lastIndex] = after.trimStart()
          index = lastIndex
        } else {
          index = lastIndex + 1
        }
        continue
      }
    }
    out.push(stripLooseDetailsTags(line))
    index += 1
  }
  return { text: out.join('\n'), slots }
}

function consumeDetails(text: string): { open: boolean; inner: string; length: number } | null {
  const openMatch = DETAILS_OPEN.exec(text)
  if (!openMatch) return null
  const open = /(?:^|\s)open(?:\s|=|$)/i.test(openMatch[1] ?? '')
  let index = openMatch[0].length
  let depth = 1
  while (index < text.length) {
    if (atFence(text, index)) {
      const next = skipFence(text, index)
      if (next < 0) return null
      index = next
      continue
    }
    const tag = /^<\/?details(?:\s[^>]*)?>/i.exec(text.slice(index))
    if (tag) {
      depth += tag[0][1] === '/' ? -1 : 1
      index += tag[0].length
      if (depth === 0) return { open, inner: text.slice(openMatch[0].length, index - tag[0].length), length: index }
      continue
    }
    index += 1
  }
  return null
}

function atFence(text: string, index: number): boolean {
  return text.startsWith('```', index) && (index === 0 || text[index - 1] === '\n')
}

function skipFence(text: string, start: number): number {
  const openEnd = text.indexOf('\n', start)
  if (openEnd < 0) return -1
  let index = openEnd + 1
  while (index < text.length) {
    if (text.startsWith('```', index)) {
      const end = text.indexOf('\n', index)
      return end < 0 ? text.length : end + 1
    }
    const next = text.indexOf('\n', index)
    if (next < 0) return -1
    index = next + 1
  }
  return -1
}

function splitSummary(inner: string): { summary: string; body: string } {
  const match = /<summary(?:\s[^>]*)?>([\s\S]*?)<\/summary>/i.exec(inner)
  if (!match) return { summary: '', body: inner }
  const body = `${inner.slice(0, match.index)}${inner.slice(match.index + match[0].length)}`
  return { summary: match[1] ?? '', body }
}

function plainSummary(summary: string): string {
  const text = summary
    .replace(/<[^>\n]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return text || 'Details'
}

function stripLooseDetailsTags(value: string): string {
  return value.replace(/<\/?details(?:\s[^>]*)?>/gi, '').replace(/<\/?summary(?:\s[^>]*)?>/gi, '')
}

function isRule(line: string): boolean {
  return /^([-*_])\1{2,}$/.test(line.trim())
}

function listItem(line: string): { ordered: boolean; text: string } | null {
  const bullet = /^[-*+]\s+(.+)$/.exec(line)
  if (bullet) return { ordered: false, text: bullet[1] ?? '' }
  const numbered = /^\d+[.)]\s+(.+)$/.exec(line)
  if (numbered) return { ordered: true, text: numbered[1] ?? '' }
  return null
}

function isListContinuation(line: string): boolean {
  return /^\s{2,}\S/.test(line) && !listItem(line) && !line.trimStart().startsWith('```')
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1
}

function isDividerRow(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('-')) return false
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)
}

function isTableStart(lines: string[], index: number): boolean {
  return isTableRow(lines[index] ?? '') && isDividerRow(lines[index + 1] ?? '')
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function joinParagraph(lines: string[]): string {
  return lines
    .map((line, index) => {
      const trimmed = line.trim()
      if (index < lines.length - 1 && / {2}$/.test(line)) return `${trimmed}\n`
      return trimmed
    })
    .join(' ')
    .replace(/ \n /g, '\n')
    .trim()
}

export function parseInlines(source: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  let index = 0
  const flush = () => {
    if (!text) return
    out.push({ type: 'text', text })
    text = ''
  }
  while (index < source.length) {
    if (source[index] === '\n') {
      flush()
      out.push({ type: 'break' })
      index += 1
      continue
    }
    if (source[index] === '`') {
      const end = source.indexOf('`', index + 1)
      if (end > index + 1) {
        flush()
        out.push({ type: 'code', text: source.slice(index + 1, end) })
        index = end + 1
        continue
      }
    }
    if (source.startsWith('**', index) || source.startsWith('__', index)) {
      const marker = source.slice(index, index + 2)
      const end = source.indexOf(marker, index + 2)
      if (end > index + 2) {
        flush()
        out.push({ type: 'strong', children: parseInlines(source.slice(index + 2, end)) })
        index = end + 2
        continue
      }
    }
    if (source[index] === '*' && source[index + 1] !== '*' && canEmphasize(source, index)) {
      const end = source.indexOf('*', index + 1)
      if (end > index + 1 && source[end - 1] !== ' ') {
        flush()
        out.push({ type: 'em', children: parseInlines(source.slice(index + 1, end)) })
        index = end + 1
        continue
      }
    }
    if (source[index] === '[') {
      const parsed = parseLink(source, index)
      if (parsed) {
        flush()
        out.push(parsed.link)
        index = parsed.next
        continue
      }
    }
    const url = /^https?:\/\/[^\s<>)]+/.exec(source.slice(index))
    if (url && (index === 0 || /\s/.test(source[index - 1] ?? ''))) {
      const href = url[0].replace(/[.,;:!?]+$/, '')
      if (safeHref(href)) {
        flush()
        out.push({ type: 'link', href, children: [{ type: 'text', text: href }] })
        index += href.length
        continue
      }
    }
    text += source[index]
    index += 1
  }
  flush()
  return out
}

function canEmphasize(source: string, index: number): boolean {
  const next = source[index + 1]
  if (!next || next === ' ' || next === '*') return false
  if (index === 0) return true
  return /[\s([{"']/.test(source[index - 1] ?? '')
}

function parseLink(source: string, index: number): { link: Inline; next: number } | null {
  const labelEnd = source.indexOf(']', index + 1)
  if (labelEnd < 0 || source[labelEnd + 1] !== '(') return null
  const hrefEnd = source.indexOf(')', labelEnd + 2)
  if (hrefEnd < 0) return null
  const href = source.slice(labelEnd + 2, hrefEnd).trim()
  if (!safeHref(href)) return null
  return {
    link: { type: 'link', href, children: parseInlines(source.slice(index + 1, labelEnd)) },
    next: hrefEnd + 1,
  }
}

function safeHref(href: string): boolean {
  if (href.startsWith('/') || href.startsWith('#')) return true
  try {
    const url = new URL(href)
    return url.protocol === 'https:' || url.protocol === 'http:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}
