import { Fragment, type ReactNode } from 'react'
import { parseMarkdown, type Block, type Inline } from '../shared/markdown.ts'

const readiedDetails = new WeakSet<HTMLDetailsElement>()

export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = parseMarkdown(text)
  if (blocks.length === 0) return null
  return <div className={className}>{blocks.map((block, index) => renderBlock(block, index))}</div>
}

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.type) {
    case 'heading': {
      const content = renderInlines(block.children)
      if (block.level === 1) return <h1 key={key}>{content}</h1>
      if (block.level === 2) return <h2 key={key}>{content}</h2>
      return <h3 key={key}>{content}</h3>
    }
    case 'paragraph':
      return <p key={key}>{renderInlines(block.children)}</p>
    case 'list': {
      const items = block.items.map((item, index) => <li key={index}>{renderInlines(item)}</li>)
      return block.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    case 'quote':
      return <blockquote key={key}>{renderInlines(block.children)}</blockquote>
    case 'code':
      return (
        <pre key={key}>
          <code>{block.text}</code>
        </pre>
      )
    case 'table':
      return (
        <table key={key}>
          <thead>
            <tr>
              {block.header.map((cell, index) => (
                <th key={index}>{renderInlines(cell)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{renderInlines(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'rule':
      return <hr key={key} />
    case 'details':
      return <DetailsBlock key={key} block={block} />
  }
}

function DetailsBlock({ block }: { block: Extract<Block, { type: 'details' }> }) {
  return (
    <details
      className="md-details"
      ref={(node) => {
        if (!node || readiedDetails.has(node)) return
        readiedDetails.add(node)
        node.open = block.open
      }}
    >
      <summary>{renderInlines(block.summary)}</summary>
      {block.children.length > 0 ? <div className="md-details-body">{block.children.map((child, index) => renderBlock(child, index))}</div> : null}
    </details>
  )
}

function renderInlines(nodes: Inline[]): ReactNode[] {
  // biome-ignore lint/suspicious/useIterableCallbackReturn: the switch covers every kind of node, which the type checker holds it to
  return nodes.map((node, index) => {
    switch (node.type) {
      case 'text':
        return <Fragment key={index}>{node.text}</Fragment>
      case 'break':
        return <br key={index} />
      case 'code':
        return <code key={index}>{node.text}</code>
      case 'strong':
        return <strong key={index}>{renderInlines(node.children)}</strong>
      case 'em':
        return <em key={index}>{renderInlines(node.children)}</em>
      case 'link':
        return (
          <a key={index} className="external" href={node.href} target="_blank" rel="noreferrer">
            {renderInlines(node.children)}
          </a>
        )
    }
  })
}
