// @vitest-environment happy-dom
import { act, useRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Fold, useSlidingRows } from '../src/web/motion.tsx'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const ROW = 50
let root: Root
let host: HTMLElement
let slides: Map<string, string>
let folds: Keyframe[][]

function Rows({ names }: { names: string[] }) {
  const body = useRef<HTMLTableSectionElement>(null)
  useSlidingRows(body)
  return (
    <table>
      <tbody ref={body}>
        {names.map((name) => (
          <tr key={name} data-flip={name} />
        ))}
      </tbody>
    </table>
  )
}

async function draw(node: React.ReactNode) {
  await act(async () => root.render(node))
}

beforeEach(() => {
  slides = new Map()
  folds = []
  window.matchMedia = (() => ({ matches: false })) as unknown as typeof window.matchMedia
  // Rows are laid out by their place in the list, since the test page has no layout of its own.
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      return [...(this.parentElement?.children ?? [])].indexOf(this) * ROW
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 120 })
  HTMLElement.prototype.animate = function (this: HTMLElement, frames: Keyframe[]) {
    if (this.dataset.flip) slides.set(this.dataset.flip, String(frames[0]!.transform))
    else folds.push(frames)
    return { cancel() {} } as Animation
  } as typeof HTMLElement.prototype.animate
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
})

describe('useSlidingRows', () => {
  const stack = Array.from({ length: 14 }, (_, index) => `stack-${index}`)

  it('slides the rows under a long stack up when it closes', async () => {
    await draw(<Rows names={['above', ...stack, 'under', 'last']} />)
    await draw(<Rows names={['above', 'stack-0', 'under', 'last']} />)
    expect(slides.has('above')).toBe(false)
    // Thirteen rows went, which is further than a re-sorted row is allowed to travel.
    expect(slides.get('under')).toBe(`translateY(${13 * ROW}px)`)
    expect(slides.get('last')).toBe(`translateY(${13 * ROW}px)`)
  })

  it('moves a row a long way without a slide when the order changed', async () => {
    const names = Array.from({ length: 14 }, (_, index) => `row-${index}`)
    await draw(<Rows names={names} />)
    await draw(<Rows names={[...names.slice(1), names[0]!]} />)
    expect(slides.has('row-0')).toBe(false)
    expect(slides.get('row-1')).toBe(`translateY(${ROW}px)`)
  })
})

describe('Fold', () => {
  it('stays on the page while it closes, then goes', async () => {
    vi.useFakeTimers()
    await draw(
      <Fold open>
        <p>Inside</p>
      </Fold>,
    )
    expect(folds).toHaveLength(0)
    await draw(
      <Fold open={false}>
        <p>Inside</p>
      </Fold>,
    )
    expect(host.textContent).toBe('Inside')
    expect(folds.at(-1)?.[1]).toMatchObject({ height: '0px' })
    await act(async () => vi.advanceTimersByTime(250))
    expect(host.textContent).toBe('')
    await draw(
      <Fold open>
        <p>Inside</p>
      </Fold>,
    )
    expect(folds.at(-1)?.[0]).toMatchObject({ height: '0px' })
    expect(folds.at(-1)?.[1]).toMatchObject({ height: '120px' })
  })

  it('keeps what is inside when asked to, hidden', async () => {
    vi.useFakeTimers()
    await draw(
      <Fold open={false} keep>
        <p>Inside</p>
      </Fold>,
    )
    expect(host.querySelector('.fold-box')?.hasAttribute('hidden')).toBe(true)
    await draw(
      <Fold open keep>
        <p>Inside</p>
      </Fold>,
    )
    expect(host.querySelector('.fold-box')?.hasAttribute('hidden')).toBe(false)
    await draw(
      <Fold open={false} keep>
        <p>Inside</p>
      </Fold>,
    )
    expect(host.querySelector('.fold-box')?.hasAttribute('hidden')).toBe(false)
    await act(async () => vi.advanceTimersByTime(250))
    expect(host.querySelector('.fold-box')?.hasAttribute('hidden')).toBe(true)
  })
})
