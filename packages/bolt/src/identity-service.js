// The browser's trusted side of AuthBOLT identities: what Hodos's own identity prompt runs.
//
// It is the identity module (identity.js) over the wallet's HTTP rails, called as the wallet itself
// (Hodos's UI sends no site domain, so the wallet treats it as internal): keys and signatures under
// the identity protocol (which the wallet refuses to every site), funding through createAction, the
// network through /boltBroadcast, and the tokens in the wallet's own table (/boltTokens, with
// `annotate` for the wallet's notes, which the wallet takes only from its own UI).
//
// `call(endpoint, body)` is the transport: it resolves with the wallet's JSON reply and throws on an
// error reply. Bundled for the Hodos frontend by scripts/bundle-identity.mjs.
import { brc100Core } from './core.js'
import { IDENTITY_PROTOCOL, IdentityWallet, decodeAuthData } from './identity.js'
import { walletBroadcaster, walletStore } from './wallet-rail.js'

export function identityService (call) {
  const wallet = Object.fromEntries(
    ['getPublicKey', 'createSignature', 'getHeaderForHeight', 'createAction'].map((m) => [m, (args) => call('/' + m, args)])
  )
  const core = brc100Core({ wallet, broadcast: walletBroadcaster(call), store: walletStore(call), protocolID: IDENTITY_PROTOCOL })
  return new IdentityWallet({ core })
}

export { decodeAuthData }
