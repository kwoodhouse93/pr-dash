import { Refused } from '../errors.ts'
import { read, type Routes } from './http.ts'

export const initiativeRoutes: Routes = (app, db) => {
  app.post('/api/initiatives', async (c) => {
    db.createInitiative((await read<{ name: string }>(c)).name ?? '')
    return c.json(db.snapshot())
  })

  app.patch('/api/initiatives/:id', async (c) => {
    db.renameInitiative(c.req.param('id'), (await read<{ name: string }>(c)).name ?? '')
    return c.json(db.snapshot())
  })

  app.delete('/api/initiatives/:id', (c) => {
    db.deleteInitiative(c.req.param('id'))
    return c.json(db.snapshot())
  })

  app.post('/api/assignments', async (c) => {
    const body = await read<{ initiativeId: string; prKeys: string[]; action: 'add' | 'remove' }>(c)
    if (!body.initiativeId || !body.prKeys?.length || (body.action !== 'add' && body.action !== 'remove')) {
      throw new Refused('initiativeId, prKeys, and action are required.')
    }
    db.setAssignments(body.initiativeId, body.prKeys, body.action)
    return c.json(db.snapshot())
  })
}
