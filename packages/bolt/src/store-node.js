// The token store on node:sqlite (Node 22.5+): tests, the live harness, and any Node host.
import { createRequire } from 'node:module'
import { sqlStore } from './store.js'

/**
 * A token store backed by node:sqlite (Node 22.5+). `path` defaults to in-memory. node:sqlite is
 * imported lazily so consumers that use another backend never trigger its experimental warning.
 */
export function nodeSqliteStore (path = ':memory:', opts = {}) {
  const require = createRequire(import.meta.url)
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(path)
  const adapter = {
    exec: (sql) => db.exec(sql),
    run: (sql, params = []) => db.prepare(sql).run(...params.map((p) => p === undefined ? null : p)),
    get: (sql, params = []) => db.prepare(sql).get(...params.map((p) => p === undefined ? null : p)),
    all: (sql, params = []) => db.prepare(sql).all(...params.map((p) => p === undefined ? null : p)),
    close: () => db.close()
  }
  return sqlStore(adapter, opts)
}
