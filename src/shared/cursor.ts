import type { AgentSessionStatus } from './types.ts'

const RUN_STATUS: Record<string, AgentSessionStatus> = {
  CREATING: 'creating',
  RUNNING: 'running',
  FINISHED: 'finished',
  ERROR: 'failed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
}

export function cursorSessionStatus(value: string | undefined): AgentSessionStatus {
  if (!value) return 'running'
  return RUN_STATUS[value] ?? 'running'
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
