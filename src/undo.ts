// Per-Document undo/redo, backed by Loro's UndoManager: undo is
// local-peer-scoped (reverts only this peer's ops), group bracketing collapses
// same-stroke edits into one entry, and remote-import bookkeeping keeps the
// redo stack honest across other peers' edits.
import { UndoManager, type LoroDoc } from './wasm-runtime.js';

import type { UndoControllerOptions } from './types.js';

// Loro's time-based merge is permanently disabled. The undo boundary here is
// the checkpoint group bracket (`sealStep`), and the two are incompatible: a
// nonzero merge interval merges adjacent changes by *timestamp*, and that
// merge reaches ACROSS a `groupEnd()` / `groupStart()` seal, collapsing two
// separately-sealed steps into one. That silently violates the "every
// checkpoint is an undo boundary" contract (one Ctrl-Z reverts more than the
// last operation and the rendered state jumps past where the user expected).
// Same-stroke collapsing is still handled, by the open group not the clock:
// every commit between two seals brackets into one entry. Apps tune
// granularity via `setAutoCheckpointIntervalMs` and `createCheckpoint`.
const UNDO_MERGE_INTERVAL_MS = 0;

// Cap on retained undo steps (Loro's default is 100). 200 at typical AEC
// entity sizes is a few hundred KB, well below anything that matters.
const DEFAULT_MAX_UNDO_STEPS = 200;

// Commit origin the paged marker (`meta.paged:<root>`) is stamped with, and
// the one origin the undo stack ignores.
//
// The marker says which shape a root's records are stored in, so it is a fact
// about the store rather than a step the reader took: undoing it leaves the
// pages the crossing mutation sealed behind a marker that says unpaged, which
// every reader answers by handing back the page entries themselves. The write
// that carries it therefore commits alone, so nothing an app authored is
// excluded alongside it.
export const PAGING_COMMIT_ORIGIN = 'brass.paging';

// Thin wrapper around Loro's UndoManager exposing only what the Document
// needs. Owned by the Document; not part of the public SDK surface.
export class UndoController {
  private readonly _mgr: UndoManager;
  // Whether an implicit group is open. The Document keeps one open between
  // checkpoints so `createCheckpoint` is THE undo boundary: every commit
  // between two checkpoints collapses into one step. `sealStep` closes and
  // reopens the group, the only way to force a boundary into Loro's stack
  // (Loro has no "force boundary here" primitive). This is a hard boundary
  // only because the merge interval is disabled (see above).
  private _groupOpen = false;

  constructor(loroDoc: LoroDoc, options?: UndoControllerOptions) {
    this._mgr = new UndoManager(loroDoc, {
      mergeInterval: UNDO_MERGE_INTERVAL_MS,
      maxUndoSteps: options?.maxUndoSteps ?? DEFAULT_MAX_UNDO_STEPS,
      excludeOriginPrefixes: [PAGING_COMMIT_ORIGIN],
    });
    // Open the implicit group so commits before the first `createCheckpoint`
    // still bracket as one undo step.
    this._mgr.groupStart();
    this._groupOpen = true;
  }

  // undo/redo run OUTSIDE the implicit group: Loro groups every commit while a
  // group is open, INCLUDING the one a `redo()` / `undo()` itself produces, so
  // running them inside would fold the reapplied step into the group and the
  // next sealed edit would merge with it (one Ctrl-Z reverts both). Closing
  // first also makes unsealed pending commits their own boundary.
  undo(): boolean {
    return this.outsideGroup(() => this._mgr.undo());
  }

  redo(): boolean {
    return this.outsideGroup(() => this._mgr.redo());
  }

  private outsideGroup(op: () => boolean): boolean {
    if (this._groupOpen) {
      this._mgr.groupEnd();
      this._groupOpen = false;
    }
    try {
      return op();
    } finally {
      this._mgr.groupStart();
      this._groupOpen = true;
    }
  }

  canUndo(): boolean {
    return this._mgr.canUndo();
  }

  canRedo(): boolean {
    return this._mgr.canRedo();
  }

  // Seal the current undo step: close the implicit group (commits since the
  // previous seal collapse into one entry) and open a fresh one.
  // `createCheckpoint` and the auto-checkpoint scheduler call this so every
  // checkpoint is a Ctrl-Z boundary. Idempotent: calling twice with no
  // intervening commit is safe (Loro collapses the empty group).
  sealStep(): void {
    if (this._groupOpen) {
      this._mgr.groupEnd();
      this._groupOpen = false;
    }
    this._mgr.groupStart();
    this._groupOpen = true;
  }

  // Drop both stacks. Called by `_applySnapshot`: the prior entries reference a
  // state the new snapshot superseded.
  clear(): void {
    // Close the open group first so `clear()` sees a clean state (defensive;
    // Loro's `clear` drops both stacks regardless).
    if (this._groupOpen) {
      this._mgr.groupEnd();
      this._groupOpen = false;
    }
    this._mgr.clear();
    this._mgr.groupStart();
    this._groupOpen = true;
  }

  free(): void {
    if (this._groupOpen) {
      try {
        this._mgr.groupEnd();
      } catch {
        // Best-effort; the underlying manager is about to free.
      }
      this._groupOpen = false;
    }
    this._mgr.free();
  }
}
