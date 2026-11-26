import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './icons.tsx'
import { dismiss, soundFor } from './sounds.ts'

type ActiveMenu = { id: string; element: HTMLElement; pinned: boolean }

type MenuApi = {
  active: ActiveMenu | null
  hover: (id: string, element: HTMLElement) => void
  leave: () => void
  pin: (id: string, element: HTMLElement) => void
  close: () => void
}

const MenuContext = createContext<MenuApi | null>(null)

/** Whether the popup that is open holds text someone typed. Such a popup stays open until it is closed on purpose. */
function holdsDraft(): boolean {
  return [...document.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>('.popover :is(textarea, [data-draft])')].some(
    (field) => field.value.trim().length > 0,
  )
}

export function MenuProvider({ children }: { children: ReactNode }) {
  const [active, setActive] = useState<ActiveMenu | null>(null)
  const timer = useRef<number>(0)
  const generation = useRef(0)
  const activeRef = useRef(active)
  activeRef.current = active

  const api: MenuApi = {
    active,
    hover(id, element) {
      const ticket = ++generation.current
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        if (ticket !== generation.current) return
        if (activeRef.current?.pinned && activeRef.current.id !== id) return
        setActive((current) => ({ id, element, pinned: current?.id === id ? current.pinned : false }))
      }, 140)
    },
    leave() {
      const ticket = ++generation.current
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        if (ticket !== generation.current) return
        setActive((current) => (current?.pinned ? current : null))
      }, 200)
    },
    pin(id, element) {
      // Another popup does not take the place of one with a draft in it.
      if (activeRef.current && activeRef.current.id !== id && holdsDraft()) return
      ++generation.current
      window.clearTimeout(timer.current)
      setActive((current) => (current?.id === id && current.pinned ? null : { id, element, pinned: true }))
    },
    close() {
      ++generation.current
      window.clearTimeout(timer.current)
      setActive(null)
    },
  }

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !activeRef.current) return
      dismiss()
      setActive(null)
    }
    const onScroll = (event: Event) => {
      const target = event.target
      if (target instanceof Element && target.closest('.popover')) return
      // A popup with a draft in it stays, and moves with its button.
      if (activeRef.current && holdsDraft()) return
      setActive(null)
    }
    // Heard on the way down, so a button that keeps its click to itself still closes the popup.
    const onPress = (event: PointerEvent) => {
      const open = activeRef.current
      const target = event.target
      if (!open || !(target instanceof Node)) return
      if (open.element.contains(target)) return
      if (target instanceof Element && target.closest('.popover')) return
      if (holdsDraft()) return
      // A button pressed outside makes its own sound.
      if (!soundFor(target) && !(target instanceof Element && target.closest('.popover-close'))) dismiss()
      setActive(null)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    document.addEventListener('pointerdown', onPress, true)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('pointerdown', onPress, true)
    }
  }, [])

  return <MenuContext.Provider value={api}>{children}</MenuContext.Provider>
}

function useMenu(): MenuApi {
  const menu = useContext(MenuContext)
  if (!menu) throw new Error('MenuProvider is missing')
  return menu
}

export function HoverCard({
  id,
  className,
  label,
  disabled = false,
  children,
}: {
  id: string
  className?: string
  label: ReactNode
  disabled?: boolean
  children: ReactNode
}) {
  const menu = useMenu()
  const ref = useRef<HTMLButtonElement>(null)
  const open = menu.active?.id === id
  useEffect(() => {
    if (disabled && open) menu.close()
  }, [disabled, open, menu])
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        disabled={disabled}
        aria-expanded={open}
        onMouseEnter={() => !disabled && ref.current && menu.hover(id, ref.current)}
        onMouseLeave={() => menu.leave()}
        onClick={(event) => {
          event.stopPropagation()
          if (disabled || !ref.current) return
          menu.pin(id, ref.current)
        }}
      >
        {label}
      </button>
      {open && !disabled && menu.active ? (
        <PopoverShell
          anchor={menu.active.element}
          pinned={menu.active.pinned}
          onMouseEnter={() => ref.current && menu.hover(id, ref.current)}
          onMouseLeave={() => menu.leave()}
        >
          {children}
        </PopoverShell>
      ) : null}
    </>
  )
}

export function ClickCard({
  id,
  className,
  label,
  ariaLabel,
  panelClassName,
  align = 'start',
  disabled = false,
  children,
}: {
  id: string
  className?: string
  label: ReactNode
  ariaLabel?: string
  panelClassName?: string
  /** Which edge of the button the popup lines up with. */
  align?: 'start' | 'end'
  disabled?: boolean
  children: ReactNode
}) {
  const menu = useMenu()
  const ref = useRef<HTMLButtonElement>(null)
  const open = menu.active?.id === id
  useEffect(() => {
    if (disabled && open) menu.close()
  }, [disabled, open, menu])
  return (
    <>
      <button
        ref={ref}
        type="button"
        className={className}
        disabled={disabled}
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={(event) => {
          event.stopPropagation()
          if (disabled || !ref.current) return
          menu.pin(id, ref.current)
        }}
      >
        {label}
      </button>
      {open && !disabled && menu.active ? (
        <PopoverShell anchor={menu.active.element} pinned align={align} panelClassName={panelClassName}>
          {children}
        </PopoverShell>
      ) : null}
    </>
  )
}

const GAP = 6
const EDGE = 12

/** Puts the panel under its button, or above it when there is no room below, and keeps it on the screen. */
function place(panel: HTMLElement, anchor: HTMLElement, align: 'start' | 'end') {
  const rect = anchor.getBoundingClientRect()
  const width = panel.offsetWidth
  const height = panel.offsetHeight
  const wanted = align === 'end' ? rect.right - width : rect.left
  const left = Math.max(EDGE, Math.min(wanted, window.innerWidth - width - EDGE))
  let top = rect.bottom + GAP
  if (top + height > window.innerHeight - EDGE) {
    const above = rect.top - GAP - height
    top = above >= EDGE ? above : Math.max(EDGE, window.innerHeight - height - EDGE)
  }
  panel.style.top = `${top}px`
  panel.style.left = `${left}px`
}

const PopContext = createContext<{ pinned: boolean }>({ pinned: true })

/** What the arrow keys move between in a popup. */
const ITEMS = '.menu-item:not(:disabled), .option:not(:disabled), .agent-row'

function PopoverShell({
  anchor,
  pinned,
  align = 'start',
  panelClassName,
  onMouseEnter,
  onMouseLeave,
  children,
}: {
  anchor: HTMLElement
  /** Opened with a click, so it stays until it is closed. A popup that only follows the pointer has no close button. */
  pinned: boolean
  align?: 'start' | 'end'
  panelClassName?: string
  onMouseEnter?: () => void
  onMouseLeave?: () => void
  children: ReactNode
}) {
  const panel = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const node = panel.current
    if (!node) return
    const move = () => place(node, anchor, align)
    move()
    // What is inside can grow: a list loads, or the menu turns to one of its forms.
    const watcher = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(move)
    watcher?.observe(node)
    window.addEventListener('resize', move)
    window.addEventListener('scroll', move, true)
    return () => {
      watcher?.disconnect()
      window.removeEventListener('resize', move)
      window.removeEventListener('scroll', move, true)
      // Focus goes back to the button it came from.
      if (node.contains(document.activeElement)) anchor.focus({ preventScroll: true })
    }
  }, [anchor, align])

  useEffect(() => {
    const node = panel.current
    // Focus moves in, so the keyboard reaches the popup. A field that asked for focus keeps it.
    if (pinned && node && !node.contains(document.activeElement)) node.focus({ preventScroll: true })
  }, [pinned])

  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    const node = panel.current
    if (!node) return
    if (event.key === 'Escape') {
      // One step back first, when the popup has one. Otherwise the page closes it.
      const back = node.querySelector<HTMLButtonElement>('.pop-back')
      if (!back) return
      event.stopPropagation()
      back.click()
      node.focus({ preventScroll: true })
      return
    }
    // The page's own shortcuts are for the list behind.
    event.stopPropagation()
    if (event.metaKey || event.ctrlKey || event.altKey) return
    const target = event.target as HTMLElement
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return
      const items = [...node.querySelectorAll<HTMLElement>(ITEMS)]
      if (items.length === 0) return
      event.preventDefault()
      const at = items.indexOf(document.activeElement as HTMLElement)
      const next = at < 0 ? (event.key === 'ArrowDown' ? 0 : items.length - 1) : (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      items[next]?.focus()
      return
    }
    if (event.key.length !== 1 || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
    const hit = [...node.querySelectorAll<HTMLButtonElement>('button[data-key]')].find(
      (button) => button.dataset.key === event.key.toLowerCase() && !button.disabled,
    )
    if (!hit) return
    event.preventDefault()
    hit.click()
  }

  return createPortal(
    <PopContext.Provider value={{ pinned }}>
      <div
        ref={panel}
        tabIndex={-1}
        className={['popover', panelClassName].filter(Boolean).join(' ')}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </PopContext.Provider>,
    document.body,
  )
}

/** The cross that closes a popup, a drawer or a dialog. It is the same button, in the same corner, everywhere. */
export function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button type="button" className="popover-close" aria-label="Close" onClick={onClose}>
      <Icon name="x" />
    </button>
  )
}

/**
 * The top of a popup: what it is, one line about it, and the way out. `onBack` adds the arrow that
 * returns to the step before, which Escape presses too.
 */
export function PopHead({ title, sub, onBack }: { title: ReactNode; sub?: ReactNode; onBack?: () => void }) {
  const close = useMenuClose()
  const { pinned } = useContext(PopContext)
  return (
    <header className="pop-head">
      {onBack ? (
        <button type="button" className="pop-back" aria-label="Back" onClick={onBack}>
          <Icon name="back" />
        </button>
      ) : null}
      <div className="pop-title">
        <h3>{title}</h3>
        {sub ? <p>{sub}</p> : null}
      </div>
      {pinned ? <CloseButton onClose={close} /> : null}
    </header>
  )
}

/** The part of a popup that scrolls. `list` is for rows that reach nearly to the edge. */
export function PopBody({
  list = false,
  className,
  role,
  label,
  children,
}: {
  list?: boolean
  className?: string
  role?: string
  label?: string
  children: ReactNode
}) {
  return (
    <div className={['pop-body', list ? 'list' : null, className].filter(Boolean).join(' ')} role={role} aria-label={label}>
      {children}
    </div>
  )
}

/** The bottom of a popup: a hint on the left, and what it does on the right. */
export function PopFoot({ hint, children }: { hint?: ReactNode; children?: ReactNode }) {
  return (
    <footer className="pop-foot">
      <span className="pop-hint">{hint}</span>
      {children}
    </footer>
  )
}

/**
 * A line in a menu. `name` is what it is called in full, for a screen reader, when the line itself leans on the
 * popup's heading. `hotkey` is the letter that presses it while the popup is open.
 */
export function MenuItem({
  icon,
  label,
  name,
  right,
  hotkey,
  opens = false,
  tone,
  disabled,
  title,
  onClick,
}: {
  icon: IconName
  label: ReactNode
  name?: string
  /** A quieter note at the end of the line. */
  right?: ReactNode
  hotkey?: string
  /** The line leads to another step in the same popup. */
  opens?: boolean
  tone?: 'alert' | 'warn'
  disabled?: boolean
  title?: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={['menu-item', tone].filter(Boolean).join(' ')}
      aria-label={name}
      aria-keyshortcuts={hotkey}
      data-key={hotkey}
      disabled={disabled}
      title={title}
      onClick={onClick}
    >
      <Icon name={icon} />
      <span className="menu-label">{label}</span>
      {right ? <span className="menu-right">{right}</span> : null}
      {hotkey ? <kbd aria-hidden="true">{hotkey.toUpperCase()}</kbd> : null}
      {opens ? <Icon name="chevron" className="menu-chevron" /> : null}
    </button>
  )
}

export function useMenuClose(): () => void {
  return useMenu().close
}

/** Whether the popup with this id is the one open. */
export function useMenuOpen(id: string): boolean {
  return useMenu().active?.id === id
}
