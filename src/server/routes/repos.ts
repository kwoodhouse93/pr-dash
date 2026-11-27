import { validRepoMark } from '../../shared/repo-marks.ts'
import { Refused } from '../errors.ts'
import { removeMirror } from '../git.ts'
import { loadGithubToken } from '../github-client.ts'
import { repositoryVisible } from '../github.ts'
import { repoCatalog } from '../repos.ts'
import { read, repoNamed, type Routes } from './http.ts'

export const repoRoutes: Routes = (app, db) => {
  app.get('/api/repos', async (c) => c.json(await repoCatalog(db)))

  app.post('/api/repos', async (c) => {
    const repo = repoNamed((await read<{ repo: string }>(c)).repo)
    if (!db.watchedRepos().includes(repo)) {
      const visible = await repositoryVisible(loadGithubToken(), repo)
      if (!visible) throw new Refused(`GitHub did not return ${repo}. Check the name and that this token can see it.`, 404)
      db.watchRepo(repo)
    }
    return c.json(db.snapshot())
  })

  app.post('/api/repos/mark', async (c) => {
    const body = await read<{ repo: string; icon: string; color: string }>(c)
    const repo = repoNamed(body.repo)
    if (!validRepoMark(body)) throw new Refused('Pick an icon and a colour from the list.')
    db.setRepoMark(repo, { icon: body.icon, color: body.color })
    return c.json(db.snapshot())
  })

  app.post('/api/repos/remove', async (c) => {
    const repo = repoNamed((await read<{ repo: string }>(c)).repo)
    db.forgetRepo(repo)
    await removeMirror(repo)
    return c.json(db.snapshot())
  })
}
