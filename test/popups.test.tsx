// @vitest-environment happy-dom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import { ClickCard, MenuItem, MenuProvider, PopBody, PopHead } from '../src/web/menus.tsx'

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function Steps({ pressed }: { pressed: string[] }) {
  const [step, setStep] = useState<'menu' | 'form'>('menu')
  if (step === 'form') {
    return (
      <>
        <PopHead title="Form" onBack={() => setStep('menu')} />
        <PopBody>
          <textarea aria-label="Prompt" />
        </PopBody>
      </>
    )
  }
  return (
    <>
      <PopHead title="Menu" />
      <PopBody list>
        <MenuItem icon="refresh" label="Refresh" hotkey="r" onClick={() => pressed.push('refresh')} />
        <MenuItem icon="copy" label="Copy" onClick={() => pressed.push('copy')} />
        <MenuItem icon="spark" label="Write…" hotkey="w" opens onClick={() => setStep('form')} />
      </PopBody>
    </>
  )
}

describe('popups', () => {
  let root: Root | null = null
  const pressed: string[] = []

  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.innerHTML = ''
    pressed.length = 0
  })

  function mount() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() =>
      root!.render(
        <MenuProvider>
          <ClickCard id="one" className="one" label="One">
            <Steps pressed={pressed} />
          </ClickCard>
          <ClickCard id="two" className="two" label="Two">
            <PopHead title="Second" />
          </ClickCard>
          <button type="button" className="elsewhere">
            Elsewhere
          </button>
        </MenuProvider>,
      ),
    )
  }

  const popover = () => document.querySelector<HTMLElement>('.popover')
  const title = () => popover()?.querySelector('h3')?.textContent ?? null
  const click = (selector: string) => act(() => document.querySelector<HTMLElement>(selector)!.click())
  const press = (selector: string) =>
    act(() => {
      document.querySelector(selector)!.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    })
  const key = (name: string, target: Element = document.activeElement!) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
    })
  function type(text: string) {
    const field = popover()!.querySelector('textarea')!
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, text)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  it('closes on a press outside, and not on one inside or on its own button', () => {
    mount()
    click('.one')
    expect(title()).toBe('Menu')
    press('.popover .menu-item')
    press('.one')
    expect(popover()).not.toBeNull()
    press('.elsewhere')
    expect(popover()).toBeNull()
  })

  it('has a close button, and gives focus back to the button that opened it', () => {
    mount()
    click('.one')
    expect(popover()!.contains(document.activeElement)).toBe(true)
    click('.popover .popover-close')
    expect(popover()).toBeNull()
    expect(document.activeElement).toBe(document.querySelector('.one'))
  })

  it('presses a line by its letter and moves between lines with the arrows', () => {
    mount()
    click('.one')
    key('r')
    expect(pressed).toEqual(['refresh'])
    key('ArrowDown')
    expect(document.activeElement?.textContent).toContain('Refresh')
    key('ArrowDown')
    expect(document.activeElement?.textContent).toContain('Copy')
    key('ArrowUp')
    key('ArrowUp')
    expect(document.activeElement?.textContent).toContain('Write')
  })

  it('steps back on Escape before closing', () => {
    mount()
    click('.one')
    key('w')
    expect(title()).toBe('Form')
    key('Escape', popover()!)
    expect(title()).toBe('Menu')
    key('Escape', popover()!)
    expect(popover()).toBeNull()
  })

  it('stays open while it holds a draft, until it is closed on purpose', () => {
    mount()
    click('.one')
    key('w')
    key('x', popover()!.querySelector('textarea')!)
    expect(pressed).toEqual([])
    type('Rename the helper')
    press('.elsewhere')
    expect(title()).toBe('Form')
    click('.two')
    expect(title()).toBe('Form')
    click('.popover .popover-close')
    expect(popover()).toBeNull()

    // With nothing typed, a press outside closes the form like any other popup.
    click('.one')
    key('w')
    press('.elsewhere')
    expect(popover()).toBeNull()
  })
})
