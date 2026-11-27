import { reducedMotion } from './motion.tsx'
import { themeColor } from './theme.ts'

/** The theme's status colours and its text colour. */
const TOKENS = ['green', 'amber', 'yellow', 'blue', 'purple', 'text']
const PIECES = 90
const LIFE_MS = 1800

/**
 * Throws a handful of confetti up from the bottom right, where notices appear. It is drawn over the page
 * without taking clicks, and is left out under reduced motion and while the tab is hidden.
 */
export function confetti() {
  if (reducedMotion() || document.hidden) return
  // A canvas cannot read a token, so the colours are taken as the page draws them.
  const colors = TOKENS.map(themeColor)
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
      color: colors[Math.floor(Math.random() * colors.length)]!,
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

/**
 * Confetti falling the width of the window, for a record: more than the handful a merge gets.
 * Left out under reduced motion and while the tab is hidden.
 */
export function confettiShower(pieces = 140) {
  if (reducedMotion() || document.hidden || typeof document.body.animate !== 'function') return
  const layer = document.createElement('div')
  layer.className = 'confetti'
  layer.setAttribute('aria-hidden', 'true')
  let longest = 0
  for (let index = 0; index < pieces; index++) {
    const piece = document.createElement('i')
    const size = 5 + Math.random() * 5
    piece.style.left = `${Math.random() * 100}%`
    piece.style.width = `${size}px`
    piece.style.height = `${size * (0.4 + Math.random() * 0.8)}px`
    piece.style.background = `var(--${TOKENS[index % TOKENS.length]})`
    layer.append(piece)
    const duration = 1800 + Math.random() * 1600
    const delay = Math.random() * 500
    longest = Math.max(longest, duration + delay)
    const drift = (Math.random() - 0.5) * 240
    const spin = (Math.random() - 0.5) * 1080
    piece.animate(
      [
        { transform: 'translate3d(0, -20px, 0) rotate(0deg)', opacity: 1 },
        { opacity: 1, offset: 0.75 },
        { transform: `translate3d(${drift}px, ${window.innerHeight * (0.55 + Math.random() * 0.45)}px, 0) rotate(${spin}deg)`, opacity: 0 },
      ],
      { duration, delay, easing: 'cubic-bezier(0.2, 0.6, 0.4, 1)', fill: 'both' },
    )
  }
  document.body.append(layer)
  window.setTimeout(() => layer.remove(), longest + 100)
}
