import { describe, expect, it } from 'vitest'
import { ageFill, cobwebTier } from '../src/web/format.ts'

const NOW = Date.parse('2026-11-20T12:00:00Z')
const ago = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()

describe('age ring', () => {
  it('fills over two days and stays full after', () => {
    expect(ageFill(ago(0), NOW)).toBe(0)
    expect(ageFill(ago(12), NOW)).toBe(0.25)
    expect(ageFill(ago(48), NOW)).toBe(1)
    expect(ageFill(ago(400), NOW)).toBe(1)
    expect(ageFill(null, NOW)).toBe(0)
  })

  it('gathers a cobweb past five days, more past two weeks, and the most past a month', () => {
    expect(cobwebTier(ago(24 * 5), NOW)).toBe(0)
    expect(cobwebTier(ago(24 * 5 + 1), NOW)).toBe(1)
    expect(cobwebTier(ago(24 * 14 + 1), NOW)).toBe(2)
    expect(cobwebTier(ago(24 * 30 + 1), NOW)).toBe(3)
    // A draft has no time it was ready, so it gathers none.
    expect(cobwebTier(null, NOW)).toBe(0)
  })
})
