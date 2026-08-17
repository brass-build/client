// The typed way for in-repo tooling (the benches, the fuzz harness) to wrap a
// LoroDoc it already holds. It sits in a module of its own, outside what the
// package entry reaches, so it can name Loro's types while the SDK's public
// surface stays engine-neutral.

import type { LoroDoc } from 'loro-crdt';

import { Document, type DocumentOptions } from './documents.js';

export function documentFromEngine(
  engine: LoroDoc,
  options?: DocumentOptions,
): Document {
  return Document._fromEngine(engine, options);
}
