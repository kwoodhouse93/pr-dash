import { describe, expect, it } from 'vitest'
import { parseMarkdown } from '../src/shared/markdown.ts'

describe('markdown', () => {
  it('renders the blocks a Cursor summary uses', () => {
    const blocks = parseMarkdown(`## Summary

Resolved the conflict in \`src/app.ts\` by keeping **both** changes.

- merged imports
- kept \`parseConfig\`

See [the diff](https://github.com/acme/app/pull/1).

\`\`\`ts
const ready = true
\`\`\`

| File | Choice |
| --- | --- |
| app.ts | both |
`)

    expect(blocks).toEqual([
      { type: 'heading', level: 2, children: [{ type: 'text', text: 'Summary' }] },
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'Resolved the conflict in ' },
          { type: 'code', text: 'src/app.ts' },
          { type: 'text', text: ' by keeping ' },
          { type: 'strong', children: [{ type: 'text', text: 'both' }] },
          { type: 'text', text: ' changes.' },
        ],
      },
      {
        type: 'list',
        ordered: false,
        items: [
          [{ type: 'text', text: 'merged imports' }],
          [
            { type: 'text', text: 'kept ' },
            { type: 'code', text: 'parseConfig' },
          ],
        ],
      },
      {
        type: 'paragraph',
        children: [
          { type: 'text', text: 'See ' },
          {
            type: 'link',
            href: 'https://github.com/acme/app/pull/1',
            children: [{ type: 'text', text: 'the diff' }],
          },
          { type: 'text', text: '.' },
        ],
      },
      { type: 'code', text: 'const ready = true' },
      {
        type: 'table',
        header: [[{ type: 'text', text: 'File' }], [{ type: 'text', text: 'Choice' }]],
        rows: [[[{ type: 'text', text: 'app.ts' }], [{ type: 'text', text: 'both' }]]],
      },
    ])
  })

  it('leaves unsafe links as text', () => {
    expect(parseMarkdown('[click](javascript:alert(1))')).toEqual([{ type: 'paragraph', children: [{ type: 'text', text: '[click](javascript:alert(1))' }] }])
  })

  it('keeps a details block closed unless it is marked open', () => {
    expect(
      parseMarkdown(`<details>
<summary>Hidden</summary>

Hello **there**
</details>`),
    ).toEqual([
      {
        type: 'details',
        open: false,
        summary: [{ type: 'text', text: 'Hidden' }],
        children: [
          {
            type: 'paragraph',
            children: [
              { type: 'text', text: 'Hello ' },
              { type: 'strong', children: [{ type: 'text', text: 'there' }] },
            ],
          },
        ],
      },
    ])
    expect(parseMarkdown('<details open>\n<summary>Shown</summary>\n\nHi\n</details>')[0]).toMatchObject({
      type: 'details',
      open: true,
      summary: [{ type: 'text', text: 'Shown' }],
    })
  })

  it('uses Details as the summary when a toggle has none', () => {
    expect(parseMarkdown('<details>\n\nHi\n</details>')).toEqual([
      {
        type: 'details',
        open: false,
        summary: [{ type: 'text', text: 'Details' }],
        children: [{ type: 'paragraph', children: [{ type: 'text', text: 'Hi' }] }],
      },
    ])
  })

  it('nests toggle blocks and leaves fenced examples alone', () => {
    const nested = parseMarkdown(`Intro

<details>
<summary>Outer</summary>

<details>
<summary>See **this**</summary>

Inside
</details>
</details>`)
    expect(nested[0]).toEqual({ type: 'paragraph', children: [{ type: 'text', text: 'Intro' }] })
    expect(nested[1]).toMatchObject({
      type: 'details',
      open: false,
      summary: [{ type: 'text', text: 'Outer' }],
    })
    const inner = nested[1]?.type === 'details' ? nested[1].children[0] : null
    expect(inner).toMatchObject({
      type: 'details',
      summary: [
        { type: 'text', text: 'See ' },
        { type: 'strong', children: [{ type: 'text', text: 'this' }] },
      ],
    })
    expect(parseMarkdown('```\n<details>\n<summary>Nope</summary>\n</details>\n```')).toEqual([
      { type: 'code', text: '<details>\n<summary>Nope</summary>\n</details>' },
    ])
  })

  it('keeps a code sample inside a toggle from closing it', () => {
    const blocks = parseMarkdown(`<details>
<summary>Sample</summary>

\`\`\`html
</details>
\`\`\`

After
</details>`)
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({
      type: 'details',
      summary: [{ type: 'text', text: 'Sample' }],
    })
    const children = blocks[0]?.type === 'details' ? blocks[0].children : []
    expect(children.map((block) => block.type)).toEqual(['code', 'paragraph'])
  })

  it('shows the text of an unclosed details tag', () => {
    expect(parseMarkdown('<details>\n<summary>Hi</summary>\nVisible')).toEqual([
      {
        type: 'paragraph',
        children: [{ type: 'text', text: 'Hi Visible' }],
      },
    ])
  })
})
