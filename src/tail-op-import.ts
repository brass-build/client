import { LoroDoc } from './wasm-runtime.js';

// An op whose dependencies are missing still imports here (as pending), so a
// refusal means the bytes are not an update anything could apply.
function importsIntoEmptyDoc(blob: Uint8Array): boolean {
  const probe = new LoroDoc();
  try {
    probe.import(blob);
    return true;
  } catch {
    return false;
  } finally {
    probe.free();
  }
}

/**
 * Import one op from a join's tail or a live delivery. Bytes that do not decode
 * even into an empty document can never be applied by any peer, and compaction
 * seals past them, so they are skipped: one such op in a tail must not fail
 * every open until that seal. An op that fails only against `engine`'s state
 * throws.
 */
export function importTailOp(engine: LoroDoc, blob: Uint8Array): void {
  try {
    engine.import(blob);
  } catch (err) {
    if (importsIntoEmptyDoc(blob)) throw err;
  }
}
