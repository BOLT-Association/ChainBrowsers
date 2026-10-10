// Injected at the top of the browser bundle: b017's 128-bit balance math uses Node's Buffer, so give
// the page one. Only defined if the page lacks it.
import { Buffer as BufferPolyfill } from 'buffer'
if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = BufferPolyfill
