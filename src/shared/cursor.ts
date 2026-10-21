import type { CursorSessionStatus } from './types.ts'

const RUN_STATUS: Record<string, CursorSessionStatus> = {
  CREATING: 'creating',
  RUNNING: 'running',
  FINISHED: 'finished',
  ERROR: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
}

const STATUS_RANK: Record<CursorSessionStatus, number> = {
  running: 0,
  creating: 1,
  failed: 2,
  finished: 3,
  cancelled: 4,
  expired: 5,
}

export function cursorSessionStatus(value: string | undefined): CursorSessionStatus {
  if (!value) return 'running'
  return RUN_STATUS[value] ?? 'running'
}

export function cursorSessionActive(status: CursorSessionStatus): boolean {
  return status === 'creating' || status === 'running'
}

export function cursorStatusLabel(status: CursorSessionStatus): string {
  switch (status) {
    case 'creating':
      return 'Creating'
    case 'running':
      return 'Running'
    case 'finished':
      return 'Finished'
    case 'failed':
      return 'Failed'
    case 'cancelled':
      return 'Cancelled'
    case 'expired':
      return 'Expired'
  }
}

export function leadingCursorStatus(statuses: CursorSessionStatus[]): CursorSessionStatus | null {
  if (statuses.length === 0) return null
  return [...statuses].sort((left, right) => STATUS_RANK[left] - STATUS_RANK[right])[0] ?? null
}

export function cursorPushedBranch(git: { branches?: { branch?: string | null }[] } | null | undefined): string | null {
  return git?.branches?.find((item) => item.branch)?.branch ?? null
}

export function cursorLinks(agentId: string): { webUrl: string; desktopUrl: string } {
  return {
    webUrl: `https://cursor.com/agents/${encodeURIComponent(agentId)}`,
    desktopUrl: `cursor://anysphere.cursor-deeplink/background-agent?bcId=${encodeURIComponent(agentId)}`,
  }
}
