import { Toaster, toast } from 'sonner'

const BRIEF = 4000
const READABLE = 6000

let actionErrorId: string | number | null = null

export function Toasts() {
  return (
    <Toaster
      theme="dark"
      position="bottom-right"
      closeButton
      richColors
      expand
      visibleToasts={5}
      duration={BRIEF}
      gap={10}
      offset={16}
      style={{ fontFamily: '"Source Sans 3", sans-serif', ['--width' as string]: '380px' }}
    />
  )
}

export function clearActionError() {
  if (actionErrorId == null) return
  toast.dismiss(actionErrorId)
  actionErrorId = null
}

export function toastError(message: string) {
  clearActionError()
  actionErrorId = toast.error(message, { duration: READABLE })
}

export function toastSuccess(message: string) {
  toast.success(message, { duration: BRIEF })
}

export function toastWarning(message: string, id?: string) {
  toast.warning(message, { id, duration: READABLE })
}

export function toastSticky(message: string, id: string, tone: 'info' | 'warning' | 'error' = 'info') {
  const show = tone === 'error' ? toast.error : tone === 'warning' ? toast.warning : toast.info
  show(message, { id, duration: Infinity })
}

export function dismissToast(id: string) {
  toast.dismiss(id)
}
