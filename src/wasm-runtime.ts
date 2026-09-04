// The node half of the WASM runtime seam. Node resolves each WASM-shipping
// dependency to its own node build, which readies its module as it is
// imported, so there is nothing to await and `ensureWasmReady` is the same
// call answering immediately.
//
// This is the half every importer names, so a build that applies no
// substitution at all (tsc, a node-targeting esbuild, the test runner) is
// already correct, and the browser half's `import.meta.url` asset resolution
// never reaches a bundler targeting node. `package.json`'s `browser` map
// swaps in the browser half for a bundler building this package for one, and
// `ensureWasmReady` exists so a caller awaits readiness the same way whichever
// half it got.

export * from 'loro-crdt';

/** Resolve once every WASM module this package needs is ready to run. Already
 *  true here: a node build readies its module during import, so the callers
 *  that await it on the browser half wait for nothing on this one. */
export function ensureWasmReady(): Promise<void> {
  return Promise.resolve();
}
