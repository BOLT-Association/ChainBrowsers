// The wallet's rails for a handler that runs outside the wallet (Hodos: in the page).
//
// A page cannot reach the chain service (a site's CSP and CORS forbid it) and must not be where
// tokens live (page storage belongs to one site; tokens belong to the wallet). So the wallet offers
// two endpoints, and these adapters put them behind the `broadcast` and `store` a wallet core takes:
//
//   POST /boltBroadcast { tx, txid }   -> { status: 'accepted' | 'already-seen' | 'rejected', detail }
//   POST /boltTokens    { op, ... }    -> put | get | list | spend on the wallet's token table
//
// `call(endpoint, body)` is the transport: it returns the parsed JSON reply and throws on failure.
// Imports nothing from Node, so it bundles for a page.
import { fromRow, toRow } from './store.js'

/** Broadcast through the wallet: it submits to whichever chain service it uses and reports the
 *  network's verdict. Extended Format when the inputs' sources are attached (an unmined parent). */
export function walletBroadcaster (call) {
  return async (tx) => {
    const extended = tx.inputs.every((i) => i.sourceTransaction)
    const reply = await call('/boltBroadcast', { tx: extended ? tx.toHexEF() : tx.toHex(), txid: tx.id('hex') })
    if (!reply || typeof reply.status !== 'string') throw new Error('the wallet gave no broadcast verdict')
    return { status: reply.status, detail: reply.detail }
  }
}

/**
 * The token store kept by the wallet. The wallet never destroys a token row: `delete` retires it
 * (`spent`), and `get`/`list` answer with held tokens only, which is what the handler means by both.
 * The wallet sets the timestamps and, for an outpoint it already has, keeps the token data it first
 * stored.
 */
export function walletStore (call) {
  const tokens = (body) => call('/boltTokens', body)
  return {
    async put (record) {
      await tokens({ op: 'put', row: toRow(record, 0) })
    },
    async get (id) {
      const { row } = await tokens({ op: 'get', outpoint: id })
      return row && row.status === 'held' ? fromRow(row) : undefined
    },
    async list ({ issuer, type } = {}) {
      const { rows } = await tokens({ op: 'list', status: 'held', issuer, type })
      return (rows ?? []).map(fromRow)
    },
    async delete (id) {
      await tokens({ op: 'spend', outpoint: id })
    },
    /** The wallet's own notes on a token (attributes.wallet). Hodos takes this only from its own UI. */
    async annotate (id, wallet) {
      await tokens({ op: 'annotate', outpoint: id, wallet })
    }
  }
}
