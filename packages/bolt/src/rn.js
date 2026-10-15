// What a WebView host app (bsv-browser, React Native) needs from this package, as one entry:
// the page script, the trusted-side service, and the pieces an app supplies adapters for.
// `@bsv/sdk` stays external in the bundle (scripts/bundle-rn.mjs), so the app's own SDK is used.
export { BOLT_MESSAGE, boltReply, hostService, webViewProviderScript } from './webview.js'
export { PAGE_METHODS } from './page.js'
export { TOKENS_SCHEMA, sqlStore } from './store.js'
export { BOLT_PROTOCOL, arcadeBroadcaster, memoryStore } from './core.js'
