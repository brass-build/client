// Import-guest: the app side of a platform-run import. Brass loads the app's
// own bundle with the import-mode URL flag in a headless browser it hosts,
// hands it the file over the `__brass_embed` envelope, and takes back what
// the registered importer produced, already encoded in the frozen form the
// platform seals. The mirror of `export-guest.ts`: Brass is the framer, the
// app's SDK is the guest, and the guest never authenticates or calls the API.

import {
  encodeImportStreams,
  encodeStreamBundle,
  readImportResult,
  type DocumentImporter,
  type ImportFile,
} from './import-contract.js';
import { EMBED_ENVELOPE, EMBED_PROTOCOL_VERSION } from './embed-protocol.js';
import { SDK_VERSION } from './version.js';

export const IMPORT_MODE_PARAM = '__brass_import';

// How long to wait for a late `registerImporter` before answering
// `no_importer`.
const IMPORTER_WAIT_MS = 10_000;

export function isImportMode(search: string): boolean {
  return new URLSearchParams(search).has(IMPORT_MODE_PARAM);
}

export interface ImportGuestController {
  setImporter(importer: DocumentImporter): void;
  dispose(): void;
}

interface HandedFile {
  name: string;
  content_type: string;
  bytes: Uint8Array;
}

interface PendingRequest {
  requestId: string;
  file: HandedFile;
  hostOrigin: string;
}

type Outcome =
  | { ok: true; bundle: Uint8Array; entries: number; report?: unknown }
  | {
      ok: false;
      code: 'importer_failed' | 'no_importer' | 'empty' | 'unsupported_request';
      message: string;
    };

function toImportFile(file: HandedFile): ImportFile {
  return {
    name: file.name,
    content_type: file.content_type,
    byte_size: file.bytes.byteLength,
    bytes: () => Promise.resolve(file.bytes),
  };
}

// Start listening as an import guest. Called from `Brass.init` only when
// `isImportMode(location.search)` is true.
export function startImportGuest(): ImportGuestController {
  let importer: DocumentImporter | null = null;
  let pending: PendingRequest | null = null;
  let done = false;
  let waitTimer: ReturnType<typeof setTimeout> | undefined;

  function reply(hostOrigin: string, requestId: string, outcome: Outcome): void {
    const send = (answer: Outcome): void =>
      window.parent.postMessage(
        { [EMBED_ENVELOPE]: EMBED_PROTOCOL_VERSION, type: 'import-result', requestId, ...answer },
        hostOrigin,
      );
    try {
      send(outcome);
    } catch {
      // A report the browser cannot clone (one holding a function, say) is
      // left behind, so the framer still receives the content.
      if (outcome.ok && outcome.report !== undefined) {
        const { report: _unsent, ...content } = outcome;
        try {
          send(content);
          return;
        } catch {
          // Answered as a failure below.
        }
      }
      send({ ok: false, code: 'importer_failed', message: 'The import result could not be sent.' });
    }
  }

  async function run(): Promise<void> {
    if (done || !pending || !importer) return;
    done = true;
    if (waitTimer !== undefined) clearTimeout(waitTimer);
    const { hostOrigin, requestId, file } = pending;
    let outcome: Outcome;
    try {
      const result = readImportResult(await importer(toImportFile(file)));
      const streams = result === null ? [] : await encodeImportStreams(result);
      if (result === null || streams.length === 0) {
        outcome = { ok: false, code: 'empty', message: 'The importer returned no content.' };
      } else {
        outcome = {
          ok: true,
          bundle: encodeStreamBundle(streams),
          entries: streams.reduce((sum, s) => sum + s.entries, 0),
          ...(result.report !== undefined ? { report: result.report } : {}),
        };
      }
    } catch (err) {
      outcome = {
        ok: false,
        code: 'importer_failed',
        message: err instanceof Error ? err.message : 'The importer failed.',
      };
    }
    reply(hostOrigin, requestId, outcome);
  }

  function onMessage(event: MessageEvent): void {
    if (event.source !== window.parent) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || !(EMBED_ENVELOPE in data)) return;
    if (pending !== null) return;
    const requestId = typeof data['requestId'] === 'string' ? data['requestId'] : '';
    // Anything the framer sends that this guest cannot serve is answered at
    // once, so the framer never waits out its own timeout on it.
    const unsupported = (): void =>
      reply(event.origin, requestId, {
        ok: false,
        code: 'unsupported_request',
        message: 'This app cannot serve that import request.',
      });
    if (data[EMBED_ENVELOPE] !== EMBED_PROTOCOL_VERSION || data['type'] !== 'import-request') {
      unsupported();
      return;
    }
    const files = data['files'];
    // The request carries a list, and an importer reads one file.
    if (requestId === '' || !Array.isArray(files) || files.length !== 1) {
      unsupported();
      return;
    }
    const file = files[0] as Record<string, unknown> | null;
    if (
      typeof file?.['name'] !== 'string' ||
      typeof file['content_type'] !== 'string' ||
      !(file['bytes'] instanceof Uint8Array)
    ) {
      unsupported();
      return;
    }
    pending = {
      requestId,
      file: { name: file['name'], content_type: file['content_type'], bytes: file['bytes'] },
      hostOrigin: event.origin,
    };
    if (importer) {
      void run();
    } else {
      waitTimer = setTimeout(() => {
        if (done || !pending) return;
        done = true;
        reply(pending.hostOrigin, pending.requestId, {
          ok: false,
          code: 'no_importer',
          message: 'No importer registered.',
        });
      }, IMPORTER_WAIT_MS);
    }
  }

  window.addEventListener('message', onMessage);
  // `accepts` names the forms a request may hand the file in.
  window.parent.postMessage(
    { [EMBED_ENVELOPE]: EMBED_PROTOCOL_VERSION, type: 'ready', sdk: SDK_VERSION, accepts: ['bytes'] },
    '*',
  );

  return {
    setImporter(next: DocumentImporter): void {
      importer = next;
      if (pending) void run();
    },
    dispose(): void {
      window.removeEventListener('message', onMessage);
      if (waitTimer !== undefined) clearTimeout(waitTimer);
    },
  };
}
