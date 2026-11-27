import type { ChaseMessage } from '../chase.ts'
import { toastError, toastSuccess } from '../toasts.tsx'

export async function copyPlain(text: string, confirmation: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    toastSuccess(confirmation)
    return true
  } catch {
    toastError('Could not copy to the clipboard')
    return false
  }
}

/** Rich text where the clipboard takes it, so links survive a paste into Slack. */
export async function copyRich(message: ChaseMessage, confirmation: string): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([message.html], { type: 'text/html' }),
          'text/plain': new Blob([message.text], { type: 'text/plain' }),
        }),
      ])
    } else {
      await navigator.clipboard.writeText(message.text)
    }
    toastSuccess(confirmation)
    return true
  } catch {
    toastError('Could not copy to the clipboard')
    return false
  }
}
