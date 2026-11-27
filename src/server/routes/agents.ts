import { agentBlocker, isAgentProvider, parseAgentRequest } from '../../shared/agents.ts'
import { agentSettings, launchAgent } from '../agents.ts'
import { Refused } from '../errors.ts'
import { t3PairLink } from '../t3.ts'
import { listedPull, read, repoNamed, type Routes } from './http.ts'

export const agentRoutes: Routes = (app, db, { loopbackOnly }) => {
  app.post('/api/pulls/agents', async (c) => {
    const body = await read<{ key: string; provider: unknown }>(c)
    const request = parseAgentRequest(body)
    if (!body.key || !request) throw new Refused('A pull request and an agent kind are required.')
    if (body.provider != null && !isAgentProvider(body.provider)) throw new Refused('That is not an agent provider.')
    const pr = listedPull(db, body.key)
    const blocked = agentBlocker(pr, request)
    if (blocked) throw new Refused(blocked, 409)
    const session = await launchAgent(db, pr, request, body.provider ?? null)
    return c.json({ snapshot: db.snapshot(), agentId: session.agentId, provider: session.provider, url: session.url })
  })

  app.get('/api/agents', async (c) => c.json(await agentSettings(db)))

  app.post('/api/agents', async (c) => {
    const { defaultProvider } = await read<{ defaultProvider: unknown }>(c)
    if (!isAgentProvider(defaultProvider)) throw new Refused('Pick an agent provider from the list.')
    db.setDefaultProvider(defaultProvider)
    return c.json({ settings: await agentSettings(db), snapshot: db.snapshot() })
  })

  app.post('/api/agents/t3/pair', async (c) => {
    // The link lets its holder into T3 Code on this machine, so it is only made for a dashboard that is on this machine too.
    if (!loopbackOnly) throw new Refused('Pairing with T3 Code is only offered when the dashboard runs on this machine.', 403)
    return c.json(await t3PairLink())
  })

  app.post('/api/agents/repo', async (c) => {
    const body = await read<{ repo: string; provider: unknown; checkout: unknown }>(c)
    const repo = repoNamed(body.repo)
    if (!db.watchedRepos().includes(repo)) throw new Refused(`${repo} is not one of your repositories.`, 404)
    if (body.provider != null && !isAgentProvider(body.provider)) throw new Refused('Pick an agent provider from the list.')
    if (body.checkout != null && typeof body.checkout !== 'string') throw new Refused('Give the folder as text.')
    const checkout = body.checkout?.trim().slice(0, 1000) || null
    db.setRepoAgent(repo, { provider: body.provider ?? null, environmentId: db.repoAgents().get(repo)?.environmentId ?? null, checkout })
    return c.json({ settings: await agentSettings(db), snapshot: db.snapshot() })
  })
}
