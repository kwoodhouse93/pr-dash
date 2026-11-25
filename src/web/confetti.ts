import { reducedMotion } from './motion.tsx'

const COLORS = ['#8fbf73', '#e0a15a', '#e2b34a', '#7eb0d4', '#a993d6', '#f3f0e7']
const PIECES = 90
const LIFE_MS = 1800

/**
 * Throws a handful of confetti up from the bottom right, where notices appear. It is drawn over the page
 * without taking clicks, and is left out under reduced motion and while the tab is hidden.
 */
export function confetti() {
  if (reducedMotion() || document.hidden) return
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const scale = window.devicePixelRatio || 1
  const width = window.innerWidth
  const height = window.innerHeight
  canvas.width = width * scale
  canvas.height = height * scale
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483647'
  document.body.append(canvas)
  ctx.scale(scale, scale)

  const pieces = Array.from({ length: PIECES }, () => {
    // Up and to the left, fanned over about a quarter turn.
    const angle = Math.PI * (1.05 + Math.random() * 0.45)
    const speed = 9 + Math.random() * 13
    return {
      x: width - 200,
      y: height - 60,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 5 + Math.random() * 5,
      spin: Math.random() * Math.PI,
      turn: (Math.random() - 0.5) * 0.4,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]!,
    }
  })

  const started = performance.now()
  let last = started
  function frame(now: number) {
    const age = now - started
    if (age > LIFE_MS) return canvas.remove()
    // Paced by the clock, so it falls at the same speed on any display.
    const step = Math.min(3, (now - last) / 16.7)
    last = now
    ctx!.clearRect(0, 0, width, height)
    ctx!.globalAlpha = Math.min(1, (LIFE_MS - age) / 500)
    for (const piece of pieces) {
      piece.vx *= 0.985 ** step
      piece.vy = piece.vy * 0.985 ** step + 0.38 * step
      piece.x += piece.vx * step
      piece.y += piece.vy * step
      piece.spin += piece.turn * step
      ctx!.save()
      ctx!.translate(piece.x, piece.y)
      ctx!.rotate(piece.spin)
      ctx!.fillStyle = piece.color
      // Narrowing with the spin makes a flat piece look as if it tumbles.
      ctx!.fillRect(-piece.size / 2, (-piece.size / 2) * Math.cos(piece.spin * 2), piece.size, piece.size * 0.6)
      ctx!.restore()
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
