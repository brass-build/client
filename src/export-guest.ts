// Export-guest: the app side of platform-initiated export when no app is
// already framing the document. The standalone dashboard and the
// drive-push path have no live app, so Brass loads the app's own bundle
// in a hidden iframe with the export-mode URL flag, hands it the
// document snapshot, and asks it to serialize. The roles invert from the
// usual hosted-UI case (see `hosted-ui.ts`): Brass is the framer (host)
// and the app's SDK is the guest.
//
// The guest never authenticates and never calls the API: it serializes
// the handed-in snapshot, so a partitioned auth cookie in the framed
// context is irrelevant. Reuses the `__brass_embed` envelope and the
// `export-request` / `export-result` pair with the direction flipped
// (framer -> guest carries the snapshot; guest -> framer the bytes).

import { Document } from './documents.js';
import type { DocumentStreamInfo } from './documents-namespace.js';
import type { StreamRuntime } from './document-streams.js';
import type { DocumentSerializer, StoredDocument } from './serializer.js';
import { EMBED_ENVELOPE, EMBED_PROTOCOL_VERSION } from './embed-protocol.js';

// The URL flag Brass appends when it frames an app purely to serialize.
// A normal app load never carries it, so a real user visit is untouched.
export const EXPORT_MODE_PARAM = '__brass_export';

// How long to wait for a late `registerSerializer` before answering
// `no_serializer`, so the framer falls back to the server export without
// waiting out its own longer timeout. Generous enough for an app doing
// async setup before it registers.
const SERIALIZER_WAIT_MS = 10_000;

// How long a single proxied stream fetch (manifest or line snapshot) waits
// on the framer before rejecting, so a serializer awaiting `doc.stream()`
// during a headless export cannot hang past the framer's own export budget.
const STREAM_REQUEST_TIMEOUT_MS = 20_000;

// Search string passed in so this is pure and testable.
export function isExportMode(search: string): boolean {
  return new URLSearchParams(search).has(EXPORT_MODE_PARAM);
}

export interface ExportGuestController {
  // `Brass.registerSerializer` forwards here so a serializer registered
  // after the snapshot arrives still completes the export.
  setSerializer(serializer: DocumentSerializer): void;
  dispose(): void;
}

interface PendingRequest {
  requestId: string;
  // The document being serialized, so `doc.id` reads the same here as it
  // does when the serializer runs against a live open. A serializer that
  // writes the document id into its output is doing an ordinary thing, and
  // it would otherwise get a real id on one export path and null on the
  // other. Absent from an older framer's request, where it stays null.
  docId: string | null;
  // The sealed snapshot bytes, or null for a doc with no snapshot yet.
  snapshot: Uint8Array | null;
  // Tail op blobs since the snapshot, ordered by seq. Applying them over
  // the snapshot matches what a live open sees, so the export reflects
  // the user's latest edits, not the last sealed snapshot.
  tailOps: Uint8Array[];
  hostOrigin: string;
}

// Start listening as a framed export guest. Called from `Brass.init`
// only when `isExportMode(location.search)` is true.
export function startExportGuest(): ExportGuestController {
  let serializer: DocumentSerializer | null = null;
  let pending: PendingRequest | null = null;
  let done = false;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;

  // In-flight proxied stream fetches, keyed by requestId. A serializer that
  // opens a partitioned document's streams (`doc.stream(name)`) resolves
  // them over the bridge: the framer has the auth to fetch each stream's
  // manifest + line snapshot, the detached guest does not.
  const pendingStreamFetches = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let streamRequestSeq = 0;

  // Ask the framer for stream data over the bridge and await its reply.
  // Rejects on timeout so a serializer cannot hang past the framer's export
  // budget (the framer then falls back / reports the failure).
  function fetchFromFramer(
    hostOrigin: string,
    type: 'stream-list-request' | 'stream-snapshot-request',
    extra: Record<string, unknown>,
  ): Promise<unknown> {
    const requestId = `str_${(streamRequestSeq += 1)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingStreamFetches.delete(requestId);
        reject(new Error('Timed out fetching stream data from the export host.'));
      }, STREAM_REQUEST_TIMEOUT_MS);
      pendingStreamFetches.set(requestId, { resolve, reject, timer });
      window.parent.postMessage(
        { [EMBED_ENVELOPE]: EMBED_PROTOCOL_VERSION, type, requestId, ...extra },
        hostOrigin,
      );
    });
  }

  // A StreamRuntime whose list / openLine are served by the framer, so the
  // detached export Document opens streams without any network of its own.
  // create() is refused: an export is read-only.
  function makeStreamRuntime(hostOrigin: string): StreamRuntime {
    return {
      list: async () => {
        const res = (await fetchFromFramer(
          hostOrigin,
          'stream-list-request',
          {},
        )) as { streams: DocumentStreamInfo[] };
        return res.streams;
      },
      openLine: async (lineId: string) => {
        const res = (await fetchFromFramer(hostOrigin, 'stream-snapshot-request', {
          lineId,
        })) as { snapshot: Uint8Array | null; tailOps: Uint8Array[] };
        const inner = res.snapshot
          ? Document.openFromSnapshot(res.snapshot)
          : Document.create();
        for (const op of res.tailOps) inner.applyRemoteOp(op);
        return inner;
      },
      create: () => {
        throw new Error('Cannot create a stream during a headless export.');
      },
    };
  }

  function reply(
    hostOrigin: string,
    requestId: string,
    outcome:
      | { ok: true; bytes: Uint8Array }
      | { ok: false; code: string; message: string },
  ): void {
    window.parent.postMessage(
      { [EMBED_ENVELOPE]: EMBED_PROTOCOL_VERSION, type: 'export-result', requestId, ...outcome },
      hostOrigin,
    );
  }

  async function run(): Promise<void> {
    if (done || !pending || !serializer) return;
    done = true;
    if (waitTimer !== undefined) clearTimeout(waitTimer);
    const { hostOrigin, requestId, docId, snapshot, tailOps } = pending;
    const identity = docId !== null ? { docId } : {};
    try {
      // A detached, in-memory Document over the snapshot + tail: the
      // serializer reads records as it would from a live open, and its
      // default-stream reads touch nothing. A serializer that opens a
      // partitioned document's other streams (`doc.stream(name)`) resolves
      // them over the bridge through the runtime below, so a partitioned
      // document exports in full headless, not just its default stream.
      const doc = snapshot
        ? Document.openFromSnapshot(snapshot, identity)
        : Document.create(identity);
      for (const op of tailOps) doc.applyRemoteOp(op);
      doc.setStreamRuntime(makeStreamRuntime(hostOrigin));
      // A serializer runs detached, with no subscription to have been fed by,
      // and it needs the document once, so it is handed the containers whole
      // (`StoredDocument`) rather than the fed surface an app holds.
      const bytes = await serializer(doc as StoredDocument & Document);
      reply(hostOrigin, requestId, { ok: true, bytes });
    } catch (err) {
      reply(hostOrigin, requestId, {
        ok: false,
        code: 'serializer_failed',
        message: err instanceof Error ? err.message : 'Serializer failed.',
      });
    }
  }

  function onMessage(event: MessageEvent): void {
    // Source pinning, the counterpart of the origin pins below and of the
    // one the host side applies: `window.parent` is the framer this guest
    // replies to, so a message from any other window is not part of this
    // exchange whatever origin it claims.
    if (event.source !== window.parent) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data[EMBED_ENVELOPE] !== EMBED_PROTOCOL_VERSION) return;

    // A reply to a proxied stream fetch. Accept only from the pinned framer
    // origin (set once the export request arrives), so a second frame cannot
    // feed the serializer forged stream bytes.
    if (
      data['type'] === 'stream-list-result' ||
      data['type'] === 'stream-snapshot-result'
    ) {
      if (!pending || event.origin !== pending.hostOrigin) return;
      const requestId = data['requestId'];
      if (typeof requestId !== 'string') return;
      const fetch = pendingStreamFetches.get(requestId);
      if (!fetch) return;
      pendingStreamFetches.delete(requestId);
      clearTimeout(fetch.timer);
      if (data['ok'] === true) {
        if (data['type'] === 'stream-list-result') {
          fetch.resolve({
            streams: Array.isArray(data['streams']) ? data['streams'] : [],
          });
        } else {
          fetch.resolve({
            snapshot: data['snapshot'] instanceof Uint8Array ? data['snapshot'] : null,
            tailOps: Array.isArray(data['tailOps'])
              ? data['tailOps'].filter((op) => op instanceof Uint8Array)
              : [],
          });
        }
      } else {
        fetch.reject(
          new Error(
            typeof data['message'] === 'string'
              ? data['message']
              : 'The export host could not provide the stream.',
          ),
        );
      }
      return;
    }

    if (data['type'] !== 'export-request') return;
    // First framer to send a request wins; pin its origin so a second
    // frame cannot answer or observe.
    if (pending !== null) return;
    const requestId = data['requestId'];
    const docId = data['docId'];
    const snapshot = data['snapshot'];
    const tailOps = data['tailOps'];
    if (typeof requestId !== 'string') return;
    if (snapshot !== null && !(snapshot instanceof Uint8Array)) return;
    if (!Array.isArray(tailOps) || !tailOps.every((op) => op instanceof Uint8Array)) {
      return;
    }
    pending = {
      requestId,
      docId: typeof docId === 'string' && docId !== '' ? docId : null,
      snapshot,
      tailOps,
      hostOrigin: event.origin,
    };
    // If no serializer yet, wait briefly then answer `no_serializer` so
    // the framer falls back to the server export.
    if (serializer) {
      void run();
    } else {
      waitTimer = setTimeout(() => {
        if (done || !pending) return;
        done = true;
        reply(pending.hostOrigin, pending.requestId, {
          ok: false,
          code: 'no_serializer',
          message: 'No serializer registered.',
        });
      }, SERIALIZER_WAIT_MS);
    }
  }

  window.addEventListener('message', onMessage);
  // Announce readiness. Posted with `'*'` because the host origin is not
  // known until its first message arrives; the ping carries no data.
  window.parent.postMessage({ [EMBED_ENVELOPE]: EMBED_PROTOCOL_VERSION, type: 'ready' }, '*');

  return {
    setSerializer(next: DocumentSerializer): void {
      serializer = next;
      if (pending) void run();
    },
    dispose(): void {
      window.removeEventListener('message', onMessage);
      if (waitTimer !== undefined) clearTimeout(waitTimer);
      for (const fetch of pendingStreamFetches.values()) {
        clearTimeout(fetch.timer);
        fetch.reject(new Error('Export guest disposed.'));
      }
      pendingStreamFetches.clear();
    },
  };
}
