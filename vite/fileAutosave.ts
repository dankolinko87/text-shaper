import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import type { Plugin } from 'vite'

/**
 * The autosave, kept as a FILE by the dev server as well as in the browser.
 *
 * The browser's storage is per origin and per profile, and the profile is
 * not always the user's to keep: the preview pane inside the desktop app
 * opens a fresh one every session, so a document autosaved there vanished
 * with the session — "every time I continue the app it deletes everything".
 * Nothing had been deleted; the bucket it was saved in had.
 *
 * So while the dev server runs, the app also puts each autosave here, at
 * `.autosave/document.<port>.json` inside the project, and reads it back when the
 * browser has nothing. A file on disk outlives any browser profile, any port
 * and any session. Development only: the published site has no server to
 * talk to, and its browser's storage is the user's own.
 */

export const FILE_AUTOSAVE_PATH = '/__autosave'

export function fileAutosave(): Plugin {
  let file = ''
  return {
    name: 'text-shaper-file-autosave',
    apply: 'serve',
    configResolved(config) {
      // One file per port, so two servers on one project never write over each other.
      file = join(config.root, '.autosave', `document.${config.server.port ?? 5173}.json`)
    },
    configureServer(server) {
      server.middlewares.use(FILE_AUTOSAVE_PATH, (req, res) => {
        if (req.method === 'GET') {
          let raw: string | null = null
          try {
            raw = readFileSync(file, 'utf8')
          } catch {
            raw = null
          }
          if (!raw) {
            res.statusCode = 204
            res.end()
            return
          }
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json')
          res.setHeader('Cache-Control', 'no-store')
          res.end(raw)
          return
        }
        if (req.method === 'PUT') {
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8')
            try {
              // Only a document: anything that is not JSON with objects in it is refused.
              const parsed = JSON.parse(raw) as { objects?: unknown }
              if (!parsed || typeof parsed !== 'object' || typeof parsed.objects !== 'object') {
                res.statusCode = 400
                res.end()
                return
              }
              // Written beside and renamed over, so a crash mid-write never leaves half a file.
              mkdirSync(dirname(file), { recursive: true })
              const temporary = `${file}.tmp`
              writeFileSync(temporary, raw, 'utf8')
              renameSync(temporary, file)
              res.statusCode = 204
              res.end()
            } catch {
              res.statusCode = 500
              res.end()
            }
          })
          return
        }
        res.statusCode = 405
        res.end()
      })
    },
  }
}
