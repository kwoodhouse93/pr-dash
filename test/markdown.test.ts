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
    expect(parseMarkdown('[click](javascript:alert(1))')).toEqual([
      { type: 'paragraph', children: [{ type: 'text', text: '[click](javascript:alert(1))' }] },
    ])
  })
})
