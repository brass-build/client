// Document version-history checkpoints: app-driven `createCheckpoint`
// plus an implicit auto-checkpoint debounce that seals a marker after a
// burst of local edits settles. Both also seal the undo step, unifying
// "checkpoint" and "undo boundary": a deliberate save, an auto-seal on
// idle, and a modeler's pointerUp all produce the same Ctrl-Z boundary.
//
// The undo seal happens on every call. One writer serves both paths and
// writes a marker per call; calls made while a write is in flight share the
// next one, anchored at the state when it writes, which holds every call it
// covers. So an app can call `createCheckpoint` at the end of every user
// action without waiting on the network or handling a refusal.

import type { DocumentCheckpoint } from './documents-namespace.js';
import type { CapturedFrame } from './document-thumbnail-capture.js';

// Where a marker is written: the server seq it marks.
export interface CheckpointAnchor {
  version: number;
}

export type CheckpointCreator = (
  anchor: CheckpointAnchor,
) => Promise<DocumentCheckpoint>;

// Default auto-checkpoint debounce: sealed this long after the last
// local edit, so every app gets a version-history timeline without
// writing checkpoint code. Override or disable (0) via
// `doc.setAutoCheckpointIntervalMs(...)`.
const AUTO_CHECKPOINT_DEFAULT_MS = 60_000;

// Retry delay after a failed write, doubling per consecutive failure up to
// the ceiling. Calls made meanwhile join the retried write.
export const RETRY_BASE_MS = 5_000;
const RETRY_CEILING_MS = 10 * 60_000;

export interface CheckpointSchedulerHost {
  // Server identity; `null` on offline / test docs.
  docId(): string | null;
  // True when the doc is live (not closed / suspended). A manual
  // `createCheckpoint` rejects with "Document is closed" otherwise.
  isAttached(): boolean;
  // True when an auto-checkpoint may fire: live AND at head (a
  // historical checkout must not seal markers).
  isAutoAllowed(): boolean;
  // The version this Document shows (live-head seq or frozen checkout
  // version). The checkpoint anchors here.
  currentSeq(): number | null;
  // Seal the current undo step. Safe to call when undo is absent.
  sealUndoStep(): void;
  // True while an op this client committed locally is not acked yet.
  hasUnsavedOps(): boolean;
  // Resolve `true` once every op this client has committed locally has been
  // acked; `false` when the document went, or the acks stopped arriving.
  whenLocalOpsSaved(): Promise<boolean>;
  // Take a frame of the registered canvas for a marker; null when the
  // document has no canvas. Upload one as the picture of `version`.
  captureFrame(): Promise<CapturedFrame | null>;
  uploadFrame(frame: CapturedFrame, version: number): void;
}

interface Waiter {
  resolve: (checkpoint: DocumentCheckpoint) => void;
  reject: (err: unknown) => void;
}

// A refusal the next attempt may not meet: a network failure, a timeout, a
// rate limit, or a server fault. Anything else (no edit access, a missing
// document) answers the same way however often it is asked.
function isRetryable(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  if (typeof status !== 'number') return true;
  return status === 408 || status === 429 || status >= 500;
}

function rejectAll(waiters: Waiter[], err: unknown): void {
  for (const w of waiters) w.reject(err);
}

function resolveAll(waiters: Waiter[], checkpoint: DocumentCheckpoint): void {
  for (const w of waiters) w.resolve(checkpoint);
}

export class CheckpointScheduler {
  // Injected checkpoint-create hook (the Document owns no HTTP client).
  // `null` on offline / test paths; a manual `create` then rejects.
  private _creator: CheckpointCreator | null = null;
  // Debounce timer. `_autoIntervalMs === 0` disables it.
  private _autoTimer: ReturnType<typeof setTimeout> | null = null;
  private _autoIntervalMs: number = AUTO_CHECKPOINT_DEFAULT_MS;
  // Calls waiting for the next marker, and whether the debounce wants one.
  private _waiters: Waiter[] = [];
  private _autoWanted = false;
  // The frame the newest request took, which becomes the picture of the
  // marker that covers it. Taken with the batch, like the waiters.
  private _frame: Promise<CapturedFrame | null> | null = null;
  // The newest marker written, so a write at the same seq resolves to it
  // instead of writing again. The server Put is last-write-wins, so a
  // second write there would only replace one entry with an identical one.
  private _last: DocumentCheckpoint | null = null;
  // Earliest time the next write may start, and the timer that starts it.
  private _nextWriteAt = 0;
  private _flushTimer: ReturnType<typeof setTimeout> | null = null;
  private _flushing = false;
  private _failures = 0;
  // Bumped when the Document detaches, so a write in progress across a close
  // stops touching the queue the close already settled.
  private _epoch = 0;

  constructor(private readonly host: CheckpointSchedulerHost) {}

  setCreator(creator: CheckpointCreator | null): void {
    this._creator = creator;
  }

  // Seal the undo step now and resolve to the marker that covers this call.
  create(): Promise<DocumentCheckpoint> {
    if (!this.host.isAttached()) {
      return Promise.reject(new Error('Document is closed'));
    }
    if (this.host.docId() === null) {
      return Promise.reject(
        new Error('createCheckpoint: Document has no server identity'),
      );
    }
    if (this._creator === null) {
      return Promise.reject(
        new Error(
          'createCheckpoint: no creator attached. Opened via the SDK factory?',
        ),
      );
    }
    // Synchronous, so a mutate after this call starts the next undo step
    // however long the marker takes.
    this.host.sealUndoStep();
    // Nothing since the newest marker: it already restores this state.
    const last = this._last;
    if (
      last !== null &&
      !this.host.hasUnsavedOps() &&
      last.version === this.host.currentSeq()
    ) {
      return Promise.resolve(last);
    }
    this._frame = this.host.captureFrame();
    const result = new Promise<DocumentCheckpoint>((resolve, reject) => {
      this._waiters.push({ resolve, reject });
    });
    // Apps call this at the end of every action without awaiting it. A
    // rejection still reaches a caller that awaits; one that does not is not
    // reported as unhandled.
    result.catch(() => {});
    this._schedule();
    return result;
  }

  // Configure the auto-checkpoint debounce; `0` disables. Returns the
  // prior value so a scoped override can restore.
  setAutoIntervalMs(intervalMs: number): number {
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new Error('setAutoCheckpointIntervalMs: intervalMs must be >= 0');
    }
    const prev = this._autoIntervalMs;
    this._autoIntervalMs = intervalMs;
    if (intervalMs === 0 && this._autoTimer !== null) {
      clearTimeout(this._autoTimer);
      this._autoTimer = null;
    }
    return prev;
  }

  // Called from the Document's local-commit dispatch. Debounces so a
  // burst of edits produces ONE marker when it settles. Skips when the
  // interval is 0 or there is no creator; the fire's guard re-checks
  // closed / suspended / checkout.
  scheduleAuto(): void {
    if (this._autoIntervalMs === 0) return;
    if (this._creator === null) return;
    if (this._autoTimer !== null) {
      clearTimeout(this._autoTimer);
    }
    this._autoTimer = setTimeout(() => {
      this._autoTimer = null;
      this._fireAuto();
    }, this._autoIntervalMs);
  }

  // Cancel a pending auto-checkpoint.
  cancelAuto(): void {
    if (this._autoTimer !== null) {
      clearTimeout(this._autoTimer);
      this._autoTimer = null;
    }
  }

  // The Document is closing or being parked. Calls still waiting get one
  // marker now, outside the spacing, when every local op is acked; otherwise
  // they reject, since no marker can cover writes the server does not have.
  // Must run while the host still answers `currentSeq`.
  detach(): void {
    this.cancelAuto();
    if (this._flushTimer !== null) {
      clearTimeout(this._flushTimer);
      this._flushTimer = null;
    }
    this._epoch += 1;
    this._flushing = false;
    this._autoWanted = false;
    const batch = this._waiters;
    this._waiters = [];
    const frame = this._frame;
    this._frame = null;
    if (batch.length === 0) return;
    const seq = this.host.currentSeq();
    const creator = this._creator;
    if (creator === null || seq === null || this.host.hasUnsavedOps()) {
      rejectAll(batch, new Error('Document is closed'));
      return;
    }
    if (this._last !== null && this._last.version === seq) {
      resolveAll(batch, this._last);
      return;
    }
    creator({ version: seq }).then(
      (checkpoint) => {
        this._last = checkpoint;
        this._picture(frame, checkpoint.version);
        resolveAll(batch, checkpoint);
      },
      (err: unknown) => rejectAll(batch, err),
    );
  }

  private _fireAuto(): void {
    if (!this.host.isAutoAllowed()) return;
    if (this._creator === null) return;
    // Seal undo now so the user gets the Ctrl-Z boundary at their idle
    // point whether or not a marker is written. An edit to another stream
    // of the document leaves `currentSeq` where it was, so the check below
    // can skip the marker after such an edit, and the step still seals.
    this.host.sealUndoStep();
    // Already marked at this exact version with nothing local outstanding:
    // the newest marker already restores this state.
    if (
      !this.host.hasUnsavedOps() &&
      this._last !== null &&
      this._last.version === this.host.currentSeq()
    ) {
      return;
    }
    this._frame = this.host.captureFrame();
    this._autoWanted = true;
    this._schedule();
  }

  private _wanted(): boolean {
    return this._waiters.length > 0 || this._autoWanted;
  }

  private _schedule(): void {
    if (this._flushing || this._flushTimer !== null) return;
    if (!this._wanted()) return;
    const wait = this._nextWriteAt - Date.now();
    if (wait <= 0) {
      // Calls made in the same task still join: the write takes its batch
      // only after awaiting the acks.
      void this._flush();
      return;
    }
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      void this._flush();
    }, wait);
  }

  private _noteFailure(): void {
    this._failures += 1;
    const delay = Math.min(
      RETRY_BASE_MS * 2 ** (this._failures - 1),
      RETRY_CEILING_MS,
    );
    this._nextWriteAt = Date.now() + delay;
  }

  private async _flush(): Promise<void> {
    if (!this._wanted()) return;
    const epoch = this._epoch;
    this._flushing = true;
    try {
      await this._write(epoch);
    } finally {
      if (epoch === this._epoch) {
        this._flushing = false;
        this._schedule();
      }
    }
  }

  private async _write(epoch: number): Promise<void> {
    // The anchor is a SERVER seq, and an op the app just committed holds one
    // only once it is acked, so a marker written with writes outstanding
    // would sit below the work the calls it covers are saving, and restoring
    // it would lose them. Wait for the acks, then confirm synchronously that
    // nothing was committed between the wait ending and the anchor being
    // read.
    for (;;) {
      const saved = await this.host.whenLocalOpsSaved();
      if (epoch !== this._epoch) return;
      if (!saved) {
        // Writing anyway would produce a marker that looks like a saved
        // version and restores to a state missing the work. The calls it
        // would have covered are told instead; the debounce retries on the
        // next local edit.
        const batch = this._waiters;
        this._waiters = [];
        this._autoWanted = false;
        this._frame = null;
        this._noteFailure();
        rejectAll(
          batch,
          new Error(
            'createCheckpoint: the document has changes that are not saved yet',
          ),
        );
        return;
      }
      if (!this.host.hasUnsavedOps()) break;
    }
    const seq = this.host.currentSeq();
    const creator = this._creator;
    if (creator === null || seq === null) {
      const batch = this._waiters;
      this._waiters = [];
      this._autoWanted = false;
      this._frame = null;
      rejectAll(
        batch,
        new Error(
          creator === null
            ? 'createCheckpoint: no creator attached'
            : 'createCheckpoint: the document has no resolved version yet',
        ),
      );
      return;
    }
    if (this._autoWanted && this._waiters.length === 0) {
      // An auto marker alone is dropped once the document has moved into a
      // history checkout.
      if (!this.host.isAutoAllowed()) {
        this._autoWanted = false;
        return;
      }
    }
    // Every call queued up to this point is covered by a marker at `seq`;
    // a call after it waits for the next one.
    const batch = this._waiters;
    const autoOnly = batch.length === 0;
    this._waiters = [];
    this._autoWanted = false;
    const frame = this._frame;
    this._frame = null;
    if (this._last !== null && this._last.version === seq) {
      resolveAll(batch, this._last);
      return;
    }
    let checkpoint: DocumentCheckpoint;
    try {
      checkpoint = await creator({ version: seq });
    } catch (err) {
      if (epoch !== this._epoch) {
        rejectAll(batch, new Error('Document is closed'));
        return;
      }
      this._noteFailure();
      // An auto marker is best-effort, and the next local edit asks again.
      if (autoOnly) return;
      if (isRetryable(err)) {
        // Still owed a marker: the next write covers these calls too, and
        // takes this frame unless a newer call has taken one since.
        this._waiters = batch.concat(this._waiters);
        this._frame ??= frame;
      } else {
        rejectAll(batch, err);
      }
      return;
    }
    this._failures = 0;
    if (this._last === null || checkpoint.version >= this._last.version) {
      this._last = checkpoint;
    }
    this._picture(frame, checkpoint.version);
    resolveAll(batch, checkpoint);
  }

  // Upload the frame the newest covered call took as the marker's picture,
  // under the marker's own version, so the history pairs each entry with a
  // picture of exactly that state. Best-effort: a marker without one keeps
  // the picture the debounced capture leaves.
  private _picture(
    frame: Promise<CapturedFrame | null> | null,
    version: number,
  ): void {
    if (frame === null) return;
    void frame.then((taken) => {
      if (taken !== null) this.host.uploadFrame(taken, version);
    });
  }
}
