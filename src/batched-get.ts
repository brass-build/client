// Answers `documents.get` calls made in the same turn with one request per
// `BATCH_SIZE` ids. An app reading the record of each of several hundred
// documents calls `get` for each, usually all at once, and one request per
// document spends the API's request budget for the app's other calls and
// every other caller's. The server reads a batch's documents on one
// invocation, so a smaller batch spreads that work across invocations.
//
// A lone call is sent as its own read. Each id in a batch resolves or rejects
// exactly as its own read would, from the status and body the server answered
// for it. A platform that does not serve the batch route answers 404 for the
// whole request, and its ids are then read one at a time.

import type { ApiFetch } from './api-fetch.js';
import { brassErrorFromBody } from './api-fetch.js';
import { BrassError } from './errors.js';
import type { RequestLane } from './request-lane.js';

export const BATCH_SIZE = 20;

interface Pending<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

interface BatchResult {
  doc_id: string;
  status: number;
  body: unknown;
}

export interface BatchedGetOptions {
  apiFetch: ApiFetch;
  lane: RequestLane;
  // Reads one document on its own: the lone call, and the fallback.
  single: (docId: string) => Promise<unknown>;
  // Attempts the batch request makes against a throttled API.
  maxAttempts: number;
}

export function createBatchedGet<T>(opts: BatchedGetOptions): (docId: string) => Promise<T> {
  let waiting = new Map<string, Pending<T>>();
  let scheduled = false;

  const settle = (entry: Pending<T>, run: () => Promise<unknown>): void => {
    run().then((value) => entry.resolve(value as T), entry.reject);
  };

  const sendBatch = async (ids: string[], entries: Map<string, Pending<T>>): Promise<void> => {
    let results: BatchResult[];
    try {
      const answer = await opts.lane.run(`batch:${ids.join(',')}`, () =>
        opts.apiFetch<{ results: BatchResult[] }>({
          method: 'POST',
          path: '/documents/details',
          body: { doc_ids: ids },
          idempotent: true,
          maxAttempts: opts.maxAttempts,
        }),
      );
      results = answer.results;
    } catch (err) {
      if (err instanceof BrassError && err.status === 404) {
        for (const id of ids) settle(entries.get(id)!, () => opts.single(id));
        return;
      }
      for (const id of ids) entries.get(id)!.reject(err);
      return;
    }
    const byId = new Map(results.map((r) => [r.doc_id, r]));
    for (const id of ids) {
      const entry = entries.get(id)!;
      const result = byId.get(id);
      if (result === undefined) {
        entry.reject(new BrassError('Request failed', { status: 500 }));
      } else if (result.status >= 200 && result.status < 300) {
        entry.resolve(result.body as T);
      } else {
        entry.reject(brassErrorFromBody(result.status, result.body));
      }
    }
  };

  const flush = (): void => {
    scheduled = false;
    const entries = waiting;
    waiting = new Map();
    const ids = [...entries.keys()];
    if (ids.length === 1) {
      settle(entries.get(ids[0]!)!, () => opts.single(ids[0]!));
      return;
    }
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      void sendBatch(ids.slice(i, i + BATCH_SIZE), entries);
    }
  };

  return (docId: string): Promise<T> => {
    const pending = waiting.get(docId);
    if (pending !== undefined) return pending.promise;
    let resolve!: (value: T) => void;
    let reject!: (err: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    waiting.set(docId, { promise, resolve, reject });
    if (!scheduled) {
      scheduled = true;
      // A task rather than a microtask, so a call made from a promise callback
      // before the next task (a handler per input, a loop after an await)
      // joins the same batch.
      setTimeout(flush, 0);
    }
    return promise;
  };
}
