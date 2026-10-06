// The type-agnostic token store.
//
// The BEEF is the source of truth; every column is a generic index the recognizer fills, so a NEW
// b017 type adds a registry row and an extractor, never a column (see docs/bolt-store-review.md).
// `sqlStore` runs over a tiny SQL adapter ({exec, run, get, all}) so the same store backs Hodos
// (rusqlite) and bsv-browser (expo-sqlite); `nodeSqliteStore` (store-node.js) wires it to node:sqlite.
// This file imports nothing from Node, so it bundles for a page and for React Native.
//
// Everything we know about the ANCHOR is kept. For a held token the anchor is the tx the token
// output rests on (its own settle, or the mint): we store its txid, kind, the network status the
// broadcaster last reported, and its proof state against our own headers (proven / height / root,
// so a reorg recheck can find it). We also keep `provenance` — the anchor the package we received
// stood on — as the one step of history b017's offline check reaches.
export const TOKENS_SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  outpoint          TEXT PRIMARY KEY,            -- "<txid>.<vout>"
  type              TEXT NOT NULL,               -- b017 registry string (MinSimpleBOLT, AuthBOLT, SimpleMultiBOLT, …)
  issuer            TEXT NOT NULL,               -- 33-byte issuer pubkey (hex)
  owner_pkh         TEXT,                        -- holding key's pubKeyHash (hex)
  status            TEXT NOT NULL DEFAULT 'held',-- 'held' | 'spent'
  amount            TEXT,                        -- fungible/balance value, decimal string (128-bit); NULL for pure NFTs
  attributes        TEXT NOT NULL DEFAULT '{}',  -- JSON: type-specific fields the recognizer extracted
  beef              TEXT NOT NULL,               -- Atomic BEEF (hex): anchor + commit + settle — the source of truth
  anchor_txid       TEXT,                        -- the tx the token rests on (== outpoint's txid for a held token)
  anchor_kind       TEXT,                        -- 'mint' | 'settle'
  anchor_network    TEXT,                        -- last broadcaster status: 'accepted' | 'already-seen' | NULL
  anchor_proven     INTEGER NOT NULL DEFAULT 0,  -- 1 once a merkle path verified against our headers
  anchor_height     INTEGER,                     -- block height when proven
  anchor_merkle_root TEXT,                       -- root that proved it (for reorg recheck)
  provenance        TEXT,                        -- JSON {txid, kind, status}: the anchor the received package stood on
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_issuer_type ON tokens(issuer, type, status);
CREATE INDEX IF NOT EXISTS idx_tokens_unproven ON tokens(anchor_proven);
`

const COLUMNS = [
  'outpoint', 'type', 'issuer', 'owner_pkh', 'status', 'amount', 'attributes', 'beef',
  'anchor_txid', 'anchor_kind', 'anchor_network', 'anchor_proven', 'anchor_height', 'anchor_merkle_root',
  'provenance', 'created_at', 'updated_at'
]

const voutOf = (outpoint) => Number(String(outpoint).split('.')[1] ?? 0)

/** A handler record as a table row (the columns above). */
export function toRow (record, now) {
  const outpoint = record.outpoint ?? record.id
  const a = record.anchor ?? {}
  return {
    outpoint,
    type: record.type,
    issuer: record.issuer,
    owner_pkh: record.owner ?? record.owner_pkh ?? null,
    status: record.status ?? 'held',
    amount: record.amount ?? null,
    attributes: JSON.stringify(record.attributes ?? {}),
    beef: record.beef,
    anchor_txid: a.txid ?? null,
    anchor_kind: a.kind ?? null,
    anchor_network: a.network ?? null,
    anchor_proven: a.proven ? 1 : 0,
    anchor_height: a.height ?? null,
    anchor_merkle_root: a.merkleRoot ?? null,
    provenance: record.provenance ? JSON.stringify(record.provenance) : null,
    created_at: record.createdAt ?? now,
    updated_at: now
  }
}

/** A table row as the record the handler works with. */
export function fromRow (row) {
  if (!row) return undefined
  return {
    id: row.outpoint,
    outpoint: row.outpoint,
    vout: voutOf(row.outpoint),
    type: row.type,
    issuer: row.issuer,
    owner: row.owner_pkh ?? undefined,
    status: row.status,
    amount: row.amount ?? null,
    attributes: row.attributes ? JSON.parse(row.attributes) : {},
    beef: row.beef,
    anchor: {
      txid: row.anchor_txid ?? undefined,
      kind: row.anchor_kind ?? undefined,
      network: row.anchor_network ?? undefined,
      proven: !!row.anchor_proven,
      height: row.anchor_height ?? undefined,
      merkleRoot: row.anchor_merkle_root ?? undefined
    },
    provenance: row.provenance ? JSON.parse(row.provenance) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/**
 * A token store over a SQL adapter. The adapter is `{ exec(sql), run(sql, params[]), get(sql, params[]),
 * all(sql, params[]), close?() }` — any sync SQLite binding fits (node:sqlite, better-sqlite3, a
 * thin wrapper over rusqlite / expo-sqlite). Implements the `put`/`get`/`list`/`delete` interface the
 * handler uses, plus token-aware extras (`markSpent`, `setAnchorProof`, `balance`).
 */
export function sqlStore (db, { now = () => Date.now() } = {}) {
  db.exec(TOKENS_SCHEMA)

  const placeholders = COLUMNS.map(() => '?').join(',')
  const updates = COLUMNS.filter((c) => c !== 'outpoint' && c !== 'created_at')
    .map((c) => `${c}=excluded.${c}`).join(', ')
  const INSERT = `INSERT INTO tokens (${COLUMNS.join(',')}) VALUES (${placeholders})
    ON CONFLICT(outpoint) DO UPDATE SET ${updates}`

  return {
    async put (record) {
      const row = toRow(record, now())
      db.run(INSERT, COLUMNS.map((c) => row[c]))
    },
    async get (id) {
      return fromRow(db.get('SELECT * FROM tokens WHERE outpoint = ?', [id]))
    },
    async list ({ status = 'held', issuer, type } = {}) {
      const where = ['status = ?']
      const params = [status]
      if (issuer) { where.push('issuer = ?'); params.push(issuer) }
      if (type) { where.push('type = ?'); params.push(type) }
      return db.all(`SELECT * FROM tokens WHERE ${where.join(' AND ')} ORDER BY created_at`, params).map(fromRow)
    },
    async delete (id) {
      db.run('DELETE FROM tokens WHERE outpoint = ?', [id])
    },
    /** Keep the row but mark it spent (history), instead of deleting it. */
    async markSpent (id) {
      db.run('UPDATE tokens SET status = \'spent\', updated_at = ? WHERE outpoint = ?', [now(), id])
    },
    /** Record that the token's anchor is now proven against the header chain (a proof-poll or reorg recheck). */
    async setAnchorProof (id, { proven = true, height = null, merkleRoot = null } = {}) {
      db.run(
        'UPDATE tokens SET anchor_proven = ?, anchor_height = ?, anchor_merkle_root = ?, updated_at = ? WHERE outpoint = ?',
        [proven ? 1 : 0, height, merkleRoot, now(), id]
      )
    },
    /** Fungible balance of one token: SUM over held outputs of this (issuer, type), as a decimal string. */
    async balance (issuer, type) {
      const rows = db.all(
        'SELECT amount FROM tokens WHERE status = \'held\' AND issuer = ? AND type = ? AND amount IS NOT NULL',
        [issuer, type]
      )
      let sum = 0n
      for (const r of rows) sum += BigInt(r.amount)
      return sum.toString()
    },
    close () { db.close?.() }
  }
}
