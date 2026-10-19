// What lets a listing notice that its set moved (`DocumentList.onChanged`).
//
// A feed frame is a trigger and the listing is the truth. The socket feeds
// that cover a query's references say THAT something in their scope moved;
// the listing decides what the set is, so folder ancestry, archive members,
// type matching and the reader's own access are decided in one place, the
// server's listing, and never re-derived from frames here.

import type {
  DocumentListing,
  ListDocumentsQuery,
} from './documents-namespace.js';
import type { InputReference } from './hosted-ui.js';
import type { SubscribeOptions, WsTopicCallback } from './ws-client.js';

/** The slice of the socket client a subscription uses. */
export interface DocumentSetSocket {
  subscribe(
    topic: string,
    callback: WsTopicCallback,
    options?: SubscribeOptions,
  ): () => void;
}

/**
 * The feed topic that covers each reference: `organization:<id>`,
 * `project:<id>`, or `reference:<id>` for a document, which fires when the
 * document or anything filed under it changes.
 */
export function feedTopicsFor(refs: readonly InputReference[]): string[] {
  const topics = new Set<string>();
  for (const ref of refs) {
    if (ref.extent === 'organization') {
      topics.add(`organization:${ref.organization_id}`);
    } else if (ref.extent === 'project' && ref.project_id) {
      topics.add(`project:${ref.project_id}`);
    } else if (ref.extent === 'document' && ref.doc_id) {
      topics.add(`reference:${ref.doc_id}`);
    }
  }
  return [...topics];
}

// Frames the socket client hands a topic's callback that report on the
// subscription itself rather than on anything in its scope.
const CONTROL_FRAMES = new Set([
  'subscribed',
  'subscribed_ack',
  'unsubscribed',
  'not_subscribed',
  'server_ended',
  'error',
  'pong',
]);

/** Whether a frame on a feed could have moved what a listing answers: any
 *  data frame does, whatever its type, since the listing decides. */
export function frameCouldMoveSet(frame: unknown): boolean {
  if (frame === null || typeof frame !== 'object') return false;
  const type = (frame as { type?: unknown }).type;
  return typeof type === 'string' && !CONTROL_FRAMES.has(type);
}

/** Whether two listings differ, keyed by `doc_id`: a document joined, left,
 *  or has a different `updated_at` or work `status`. */
export function listingsDiffer(
  previous: readonly DocumentListing[],
  next: readonly DocumentListing[],
): boolean {
  if (previous.length !== next.length) return true;
  const before = new Map(previous.map((d) => [d.doc_id, d]));
  return next.some((doc) => {
    const was = before.get(doc.doc_id);
    return was === undefined || was.updated_at !== doc.updated_at || !sameStatus(was.status, doc.status);
  });
}

// An import that fails writes its status without moving the stamp, so the
// status is compared as well.
function sameStatus(a: DocumentListing['status'], b: DocumentListing['status']): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.pending === b.pending && a.blocking === b.blocking && a.message === b.message;
}

/**
 * How long a trigger waits before listing, so a burst of frames (a move
 * stamps the document and nudges both containers) is one listing.
 */
export const RELIST_COALESCE_MS = 250;

/** The longest the first listing waits for its feeds to be established. */
export const FEED_WAIT_MS = 3_000;

/**
 * Watch the set `query` lists and call `listener` whenever a listing differs
 * from the last one, starting from `initial`. Returns the stop function.
 */
export function watchDocumentSet(args: {
  query: ListDocumentsQuery;
  list: (query: ListDocumentsQuery) => Promise<DocumentListing[]>;
  socket: DocumentSetSocket | undefined;
  listener: () => void;
  initial: DocumentListing[];
}): () => void {
  const { query, list, socket, listener } = args;
  let stopped = false;
  let last = args.initial;
  let inFlight = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const relist = async (): Promise<void> => {
    if (stopped) return;
    if (inFlight) {
      // A frame that lands while a listing is out may describe a write that
      // listing already missed, so one more follows it.
      again = true;
      return;
    }
    inFlight = true;
    try {
      const next = await list(query);
      if (stopped) return;
      const moved = listingsDiffer(last, next);
      last = next;
      if (moved) listener();
    } catch (error) {
      // The watch keeps its last answer and lists again on the next trigger.
      if (!stopped) console.error('Brass.documents.list:', error);
    } finally {
      inFlight = false;
      if (again && !stopped) {
        again = false;
        schedule();
      }
    }
  };

  const schedule = (): void => {
    // Before the first listing, that listing answers whatever moved.
    if (stopped || !firstListed || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void relist();
    }, RELIST_COALESCE_MS);
  };

  // The first listing waits for the feeds to be established, so a write
  // landing between that listing and the subscription cannot fall between
  // them. A feed the socket refuses, or one that never answers, stops being
  // waited for rather than holding the first answer back.
  const awaiting = new Set<string>();
  let firstListed = false;
  const listFirst = (): void => {
    if (firstListed) return;
    firstListed = true;
    if (firstTimer !== null) clearTimeout(firstTimer);
    void relist();
  };
  const settled = (topic: string): void => {
    awaiting.delete(topic);
    if (awaiting.size === 0) listFirst();
  };

  const unsubscribes: Array<() => void> = [];
  const topics = socket ? feedTopicsFor(query.from ?? []) : [];
  for (const topic of topics) awaiting.add(topic);
  let firstTimer: ReturnType<typeof setTimeout> | null =
    topics.length > 0 ? setTimeout(listFirst, FEED_WAIT_MS) : null;
  for (const topic of topics) {
    unsubscribes.push(
      socket!.subscribe(
        topic,
        (frame) => {
          if (frameCouldMoveSet(frame)) schedule();
        },
        {
          onSubscribed: ({ resubscribed }) => {
            // Frames fanned out while the socket was down are gone, so a
            // re-established feed is answered with a listing.
            if (resubscribed) schedule();
            else settled(topic);
          },
          onEnded: () => settled(topic),
        },
      ),
    );
  }
  if (topics.length === 0) listFirst();

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) clearTimeout(timer);
    if (firstTimer !== null) clearTimeout(firstTimer);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** A listing, as `Brass.documents.list` returns it. */
export interface DocumentList {
  /** The set as it stood when it was listed. */
  readonly documents: DocumentListing[];
  /** Whether the set has moved since: a document joined it, left it, or
   *  changed (its `updated_at` or work `status`). List again to see how. */
  readonly changed: boolean;
  /** Fires once, when the set moves. The set is watched only while a
   *  listener is registered and until `close`; throws after `close`. */
  onChanged(cb: () => void): () => void;
  close(): void;
}

export function createDocumentList(args: {
  documents: DocumentListing[];
  query: ListDocumentsQuery;
  list: (query: ListDocumentsQuery) => Promise<DocumentListing[]>;
  socket: DocumentSetSocket | undefined;
}): DocumentList {
  let changed = false;
  let closed = false;
  let stopWatching: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const stopWatch = (): void => {
    stopWatching?.();
    stopWatching = null;
  };
  const markChanged = (): void => {
    if (changed || closed) return;
    changed = true;
    stopWatch();
    const fire = [...listeners];
    listeners.clear();
    for (const cb of fire) {
      try {
        cb();
      } catch (err) {
        console.error('Brass: an onChanged listener threw', err);
      }
    }
  };
  const set: DocumentList = {
    documents: args.documents,
    get changed() {
      return changed;
    },
    onChanged(cb) {
      if (closed) throw new Error('DocumentList is closed');
      if (changed) {
        queueMicrotask(() => {
          if (!closed) cb();
        });
        return () => {};
      }
      listeners.add(cb);
      stopWatching ??= watchDocumentSet({
        query: args.query,
        list: args.list,
        socket: args.socket,
        initial: args.documents,
        listener: markChanged,
      });
      return () => {
        listeners.delete(cb);
        if (listeners.size === 0) stopWatch();
      };
    },
    close() {
      closed = true;
      listeners.clear();
      stopWatch();
    },
  };
  return set;
}
