// The browser half of the WASM runtime seam: the ONE module in this package
// that names a WASM-shipping dependency, and the only place a new one is
// added. Everything else imports `./wasm-runtime.js`, whose node half this
// one replaces in a browser build, so no other file in the SDK (and no line of
// an app's own config) names a WASM dep or its loader.
//
// Each entry is loaded through its package's WEB build, which readies its
// module asynchronously behind an explicit init and locates its bytes with
// `new URL(..., import.meta.url)`. That combination is what makes the whole
// package build with no bundler plugins: every major bundler rewrites that URL
// into an emitted asset on its own, and nothing here emits a top-level await,
// so no build target has to accept one.
//
// The alternative each package offers by default is worse in a way nothing
// reports. A default browser entry fetches its module with a SYNCHRONOUS
// XMLHttpRequest while it evaluates, so an app freezes its main thread for the
// whole download before it paints, whether or not anyone opens a document, and
// the freeze grows with the reader's latency rather than with the app. That is
// what a browser build resolves to unless something selects otherwise, it
// builds clean, and the only tell is the chunk count.

// The init comes from the deeper path because the package's web entry
// re-exports its module with `export *`, which does not carry a default, so
// the entry's types do not declare the init its JavaScript exports. The two
// specifiers resolve to the same module instance (the entry imports this
// file), so readying through one readies the classes taken from the other.
import initEngine from 'loro-crdt/web/loro_wasm.js';

import { createReadyGate } from './wasm-ready-gate.js';

export * from 'loro-crdt/web';

// Every WASM module this package needs ready before it runs, as the init each
// one exports. Add an entry rather than replacing the list: a consumer with
// two installed during a migration window needs both readied, and the gate
// below is what every caller already awaits, so a new entry costs no new call
// anywhere.
const INITS: readonly (() => Promise<unknown>)[] = [initEngine];

/**
 * Resolve once every WASM module this package needs is ready to run.
 *
 * `Brass.init()` starts it and every path that constructs a document awaits
 * it, so an app that follows the documented boot never calls it. It is
 * idempotent and concurrent-safe for the paths that construct documents
 * without one (a test, an in-repo tool).
 */
export const ensureWasmReady: () => Promise<void> = createReadyGate(INITS);
