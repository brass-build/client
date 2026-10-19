// Waiting on a staged upload's seal. The platform answers `202 { seal_id }`
// once the upload is queued and seals it afterwards; the caller resolves or
// rejects on the outcome, exactly as it did on the synchronous answer.

import { brassErrorFromBody } from './api-fetch.js';
import { BrassError } from './errors.js';

/** @internal */
export type SealStatus =
  | { state: 'pending' }
  | { state: 'stored'; body: unknown }
  | {
      state: 'refused';
      status: number;
      error: string;
      code?: string;
      import_failed?: { message: string };
    };

/** @internal A seal the platform refused. `importFailed` is the failure it
 *  recorded on the document when the seal completed an import. */
export class SealRefusedError extends BrassError {
  readonly importFailed?: string;

  constructor(refused: Extract<SealStatus, { state: 'refused' }>) {
    const base = brassErrorFromBody(refused.status, {
      error: refused.error,
      ...(refused.code !== undefined ? { code: refused.code } : {}),
    });
    super(base.message, {
      ...(base.status !== undefined ? { status: base.status } : {}),
      ...(base.code !== undefined ? { code: base.code } : {}),
    });
    if (refused.import_failed !== undefined) {
      this.importFailed = refused.import_failed.message;
    }
  }
}

// The worker may take both of the queue's deliveries before the DLQ drain
// records a refusal, so the wait outlasts them.
const SEAL_WAIT_MS = 40 * 60 * 1000;
const SEAL_POLL_MS = [250, 500, 1000, 1000, 2000];
const MAX_FAILED_READS = 10;

function retryable(status: number | undefined): boolean {
  return status === undefined || status === 429 || status >= 500;
}

function sealIdOf(accepted: unknown): string | null {
  if (typeof accepted !== 'object' || accepted === null) return null;
  const id = (accepted as { seal_id?: unknown }).seal_id;
  return typeof id === 'string' && id !== '' ? id : null;
}

/** @internal Resolve with the stored outcome's body once the seal `accepted`
 *  names has landed, or throw its refusal. A body naming no seal is a server
 *  that sealed synchronously, and is the answer itself. */
export async function awaitSeal<T>(
  accepted: unknown,
  read: (sealId: string) => Promise<SealStatus>,
): Promise<T> {
  const sealId = sealIdOf(accepted);
  if (sealId === null) return accepted as T;
  const deadline = Date.now() + SEAL_WAIT_MS;
  let failedReads = 0;
  for (let attempt = 0; ; attempt += 1) {
    let status: SealStatus | null = null;
    try {
      status = await read(sealId);
      failedReads = 0;
    } catch (err) {
      // A read that failed in transit says nothing about the seal, which goes
      // on regardless; a refusal of the read itself, or a run of failures,
      // ends the wait.
      failedReads += 1;
      if (err instanceof BrassError && !retryable(err.status)) throw err;
      if (failedReads >= MAX_FAILED_READS) throw err;
    }
    if (status?.state === 'stored') return status.body as T;
    if (status?.state === 'refused') throw new SealRefusedError(status);
    if (Date.now() >= deadline) {
      throw new BrassError('The upload is taking too long to store. Try again.', {
        status: 504,
      });
    }
    const delay = SEAL_POLL_MS[Math.min(attempt, SEAL_POLL_MS.length - 1)]!;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
