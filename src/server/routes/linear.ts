import { isLinearIdentifier } from '../../shared/linear.ts'
import { Refused } from '../errors.ts'
import { linkGitHubPullRequest, listStatuses, listUsers, searchLinearIssues, updateLinearIssue } from '../linear.ts'
import { listedPull, read, type Routes } from './http.ts'

function linearToken(): string {
  const token = process.env.LINEAR_API_KEY
  if (!token) throw new Refused('Set LINEAR_API_KEY to update Linear.')
  return token
}

export const linearRoutes: Routes = (app, db) => {
  app.get('/api/linear/statuses', async (c) => {
    const token = linearToken()
    const teamId = c.req.query('teamId') || undefined
    const issue = c.req.query('issue') || undefined
    if (!teamId && !issue) throw new Refused('A Linear team or issue is required.')
    return c.json({ statuses: await listStatuses(token, { teamId, issue }) })
  })

  app.get('/api/linear/users', async (c) => c.json({ users: await listUsers(linearToken()) }))

  app.get('/api/linear/issues', async (c) => {
    const token = linearToken()
    const query = c.req.query('q')?.trim() ?? ''
    if (query.length < 2) return c.json({ issues: [] })
    return c.json({ issues: await searchLinearIssues(token, query) })
  })

  app.post('/api/linear/links', async (c) => {
    const token = linearToken()
    const body = await read<{ key: string; identifier: string }>(c)
    const key = body.key?.trim() ?? ''
    const identifier = body.identifier?.trim().toUpperCase() ?? ''
    if (!key || !isLinearIdentifier(identifier)) throw new Refused('A pull request and a Linear issue identifier are required.')
    const pr = listedPull(db, key)
    const issue = await linkGitHubPullRequest(token, identifier, pr.url, pr.title)
    return c.json(db.attachLinearIssue(pr.key, issue))
  })

  app.post('/api/linear/issues/:identifier', async (c) => {
    const token = linearToken()
    const body = await read<{ statusId: string; assigneeId: string | null }>(c)
    const hasStatus = typeof body.statusId === 'string' && body.statusId.length > 0
    const hasAssignee = Object.prototype.hasOwnProperty.call(body, 'assigneeId')
    if (!hasStatus && !hasAssignee) throw new Refused('statusId or assigneeId is required.')
    if (hasAssignee && body.assigneeId !== null && typeof body.assigneeId !== 'string') {
      throw new Refused('assigneeId must be a user id or null.')
    }
    const updated = await updateLinearIssue(token, c.req.param('identifier'), {
      ...(hasStatus ? { statusId: body.statusId } : {}),
      ...(hasAssignee ? { assigneeId: body.assigneeId ?? null } : {}),
    })
    return c.json(db.updateLinearIssue(updated.identifier, updated))
  })
}
