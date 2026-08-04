// Document version-history checkpoints: app-driven `createCheckpoint`
// plus an implicit auto-checkpoint debounce that seals a marker after a
// burst of local edits settles. Both also seal the undo step, unifying
// "checkpoint" and "undo boundary": a deliberate save, an auto-seal on
// idle, and a modeler's pointerUp all produce the same Ctrl-Z boundary.

import type { DocumentCheckpoint } from './documents-namespace.js';

export type CheckpointCreator = () => Promise<DocumentCheckpoint>;

// Default auto-checkpoint debounce: sealed this long after the last
// local edit, so every app gets a version-history timeline without
// writing checkpoint code. 60s balances "user reaches a natural pause"
// against snapshot-blob churn. Override or disable (0) via
// `doc.setAutoCheckpointIntervalMs(...)`.
const AUTO_CHECKPOINT_DEFAULT_MS = 60_000;

export interface CheckpointSchedulerHost {
  // Server identity; `null` on offline / test docs.
  docId(): string | null;
  // True when the doc is live (not closed / suspended). A manual
  // `createCheckpoint` throws "Document is closed" otherwise.
  isAttached(): boolean;
  // True when an auto-checkpoint may fire: live AND at head (a
  // historical checkout must not seal markers).
  isAutoAllowed(): boolean;
  // The version this Document shows (live-head seq or frozen checkout
  // version). The checkpoint anchors here.
  currentSeq(): number | null;
  // Seal the current undo step. Safe to call when undo is absent.
  sealUndoStep(): void;
}

export class CheckpointScheduler {
  // Injected checkpoint-create hook (the Document owns no HTTP client).
  // `null` on offline / test paths; a manual `create` then throws.
  private _creator: CheckpointCreator | null = null;
  // Debounce timer + bookkeeping. `_autoIntervalMs === 0` disables it;
  // `_lastSeq` skips a fire that would clobber a manual checkpoint at
  // the same seq.
  private _autoTimer: ReturnType<typeof setTimeout> | null = null;
  private _autoIntervalMs: number = AUTO_CHECKPOINT_DEFAULT_MS;
  private _lastSeq: number | null = null;

  constructor(private readonly host: CheckpointSchedulerHost) {}

  setCreator(creator: CheckpointCreator | null): void {
    this._creator = creator;
  }

  // Seal a checkpoint anchored to `host.currentSeq()`.
  async create(): Promise<DocumentCheckpoint> {
    if (!this.host.isAttached()) {
      throw new Error('Document is closed');
    }
    if (this.host.docId() === null) {
      throw new Error('createCheckpoint: Document has no server identity');
    }
    if (this._creator === null) {
      throw new Error(
        'createCheckpoint: no creator attached. Opened via the SDK factory?',
      );
    }
    // Seal BEFORE the round-trip: the seal is synchronous, so mutates
    // arriving during the await start a fresh undo step rather than
    // folding into the pre-checkpoint one.
    this.host.sealUndoStep();
    const result = await this._creator();
    // Record the seq so a pending auto-checkpoint at the same version
    // skips its fire. The server Put is unconditional (last-write-wins),
    // so without this an idle period right after a manual save would
    // replace the manual entry with an auto one.
    this._lastSeq = result.version;
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
      void this._fireAuto();
    }, this._autoIntervalMs);
  }

  // Cancel a pending auto-checkpoint (suspend / close).
  cancelAuto(): void {
    if (this._autoTimer !== null) {
      clearTimeout(this._autoTimer);
      this._autoTimer = null;
    }
  }

  private async _fireAuto(): Promise<void> {
    if (!this.host.isAutoAllowed()) return;
    if (this._creator === null) return;
    const seq = this.host.currentSeq();
    if (seq === null) return;
    // Already checkpointed at this exact version (manual seal a moment
    // ago).
    if (this._lastSeq === seq) return;
    // Seal undo before the write so the user gets the Ctrl-Z boundary at
    // their idle point even if the server write below fails.
    this.host.sealUndoStep();
    try {
      const result = await this._creator();
      this._lastSeq = result.version;
    } catch {
      // Best-effort: a rejection (rate limit, no write access, network)
      // is swallowed; the next local edit reschedules.
    }
  }
}
