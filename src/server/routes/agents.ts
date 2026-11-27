import { agentBlocker, isAgentProvider, LOCAL_ENVIRONMENT, parseAgentRequest } from '../../shared/agents.ts'
import { agentSettings, launchAgent } from '../agents.ts'
import { messageOf, Refused } from '../errors.ts'
import { beginT3Connect, disconnectT3, finishT3Connect } from '../t3-mcp.ts'
import { pairingCode, t3Environments, t3PairLink } from '../t3.ts'
import { listedPull, read, repoNamed, type Routes } from './http.ts'

/**
 * Where T3 Code sends the browser once the user has answered its approval page. It is outside
 * `/api` because it arrives from T3 Code's page, which the API refuses as another site.
 * The `state` it carries is what shows the answer belongs to a sign-in started here.
 */
const T3_CONNECTED = '/agents/t3/connected'

export const agentRoutes: Routes = (app, db, { loopbackOnly, address }) => {
  app.post('/api/pulls/agents', async (c) => {
    const body = await read<{ key: string; provider: unknown }>(c)
    const request = parseAgentRequest(body)
    if (!body.key || !request) throw new Refused('A pull request and an agent kind are required.')
    if (body.provider != null && !isAgentProvider(body.provider)) throw new Refused('That is not an agent provider.')
    const pr = listedPull(db, body.key)
    const blocked = agentBlocker(pr, request)
    if (blocked) throw new Refused(blocked, 409)
    const session = await launchAgent(db, pr, request, body.provider ?? null)
    return c.json({ snapshot: db.snapshot(), agentId: session.agentId, provider: session.provider, url: session.url, environmentId: session.environmentId })
  })

  app.get('/api/agents', async (c) => c.json(await agentSettings(db)))

  app.post('/api/agents', async (c) => {
    const { defaultProvider, defaultEnvironmentId } = await read<{ defaultProvider: unknown; defaultEnvironmentId: unknown }>(c)
    if (defaultEnvironmentId !== undefined) {
      db.setDefaultEnvironment(defaultEnvironmentId === null ? null : await linkedEnvironment(defaultEnvironmentId))
    } else {
      if (!isAgentProvider(defaultProvider)) throw new Refused('Pick an agent provider from the list.')
      db.setDefaultProvider(defaultProvider)
    }
    return c.json({ settings: await agentSettings(db), snapshot: db.snapshot() })
  })

  app.post('/api/agents/t3/pair', async (c) => {
    // The link lets its holder into T3 Code on this machine, so it is only made for a dashboard that is on this machine too.
    if (!loopbackOnly) throw new Refused('Pairing with T3 Code is only offered when the dashboard runs on this machine.', 403)
    return c.json(await t3PairLink())
  })

  app.post('/api/agents/t3/connect', async (c) => {
    // The sign-in runs threads in T3 Code on this machine, so like pairing it is only made for a dashboard here.
    if (!loopbackOnly) throw new Refused('Connecting to T3 Code is only offered when the dashboard runs on this machine.', 403)
    const authorizeUrl = await beginT3Connect(`${address}${T3_CONNECTED}`)
    // T3 Code's approval page asks a browser it does not know for a pairing code. One is made here so the user has it to hand.
    const code = await t3PairLink()
      .then((made) => pairingCode(made.pairUrl))
      .catch(() => null)
    return c.json({ authorizeUrl, pairingCode: code })
  })

  app.post('/api/agents/t3/disconnect', async (c) => {
    await disconnectT3()
    return c.json({ settings: await agentSettings(db), snapshot: db.snapshot() })
  })

  app.get(T3_CONNECTED, async (c) => {
    const { code, state, error, error_description: said } = c.req.query()
    try {
      if (!code || !state) throw new Error(said || (error === 'access_denied' ? 'The request was turned down in T3 Code.' : 'T3 Code sent back no answer.'))
      await finishT3Connect(code, state)
      return c.html(connectedPage('PR Dash is connected to T3 Code', 'You can close this tab and go back to PR Dash.'))
    } catch (caught) {
      return c.html(connectedPage('PR Dash could not connect to T3 Code', messageOf(caught)), 400)
    }
  })

  app.post('/api/agents/repo', async (c) => {
    const body = await read<{ repo: string; provider: unknown; checkout: unknown; environmentId: unknown }>(c)
    const repo = repoNamed(body.repo)
    if (!db.watchedRepos().includes(repo)) throw new Refused(`${repo} is not one of your repositories.`, 404)
    if (body.provider != null && !isAgentProvider(body.provider)) throw new Refused('Pick an agent provider from the list.')
    if (body.checkout != null && typeof body.checkout !== 'string') throw new Refused('Give the folder as text.')
    const checkout = body.checkout?.trim().slice(0, 1000) || null
    // Left out, the environment stays as it was. Null follows the default.
    const kept = db.repoAgents().get(repo)?.environmentId ?? null
    const asked = body.environmentId
    const environmentId = asked === undefined ? kept : asked === null || asked === LOCAL_ENVIRONMENT ? asked : await linkedEnvironment(asked)
    db.setRepoAgent(repo, { provider: body.provider ?? null, environmentId, checkout })
    return c.json({ settings: await agentSettings(db), snapshot: db.snapshot() })
  })
}

/** The id, once T3 Code says it is linked to that environment. */
async function linkedEnvironment(id: unknown): Promise<string> {
  const linked = await t3Environments().catch(() => [])
  if (typeof id !== 'string' || !linked.some((environment) => environment.id === id)) throw new Refused('Pick an environment T3 Code is linked to.')
  return id
}

function connectedPage(heading: string, detail: string): string {
  const text = (value: string) => value.replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`)
  return `<!doctype html><meta charset="utf-8"><title>${text(heading)}</title><body style="font: 16px system-ui; margin: 15vh auto; max-width: 32em; padding: 0 16px"><h1 style="font-size: 20px">${text(heading)}</h1><p>${text(detail)}</p>`
}
