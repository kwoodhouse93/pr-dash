// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { soundFor } from '../src/web/sounds.ts'

function control(html: string): Element {
  document.body.innerHTML = html
  return document.body.querySelector('[data-hit]') ?? document.body.firstElementChild!
}

describe('soundFor', () => {
  it('gives each kind of control its own sound', () => {
    expect(soundFor(control('<button class="primary merge">Merge</button>'))).toBe('halo-space')
    expect(soundFor(control('<button class="tab">Review</button>'))).toBe('halo-shift')
    expect(soundFor(control('<button class="pop-back">Back</button>'))).toBe('halo-shift')
    expect(soundFor(control('<button class="chip" aria-pressed="true">Hide drafts</button>'))).toBe('halo-soft')
    expect(soundFor(control('<div class="segmented"><button data-hit>On</button></div>'))).toBe('halo-soft')
    expect(soundFor(control('<button class="ghost merge">Ready</button>'))).toBe('halo-hard')
    expect(soundFor(control('<button class="tool-btn refresh-tool">Refresh</button>'))).toBe('halo-hard')
  })

  it('sounds a button that opens a popup, whatever it looks like', () => {
    expect(soundFor(control('<button class="ci-pill" aria-expanded="false">Checks</button>'))).toBe('halo-soft')
    expect(soundFor(control('<button class="section-toggle" aria-expanded="true">Fold</button>'))).toBeNull()
  })

  it('finds the button around what was pressed', () => {
    expect(soundFor(control('<button class="primary"><span data-hit>Merge</span></button>'))).toBe('halo-space')
  })

  it('stays quiet for a disabled button, plain text and a control that opts out', () => {
    expect(soundFor(control('<button class="primary" disabled>Merge</button>'))).toBeNull()
    expect(soundFor(control('<p>Nothing</p>'))).toBeNull()
    expect(soundFor(control('<button class="text-btn">Cancel</button>'))).toBeNull()
    expect(soundFor(control('<button class="primary" data-sound="off">Merge</button>'))).toBeNull()
  })

  it('lets a control name its own sound', () => {
    expect(soundFor(control('<button class="text-btn" data-sound="halo-shift">Open</button>'))).toBe('halo-shift')
  })
})
