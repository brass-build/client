// Per-Document undo/redo, backed by Loro's UndoManager: undo is
// local-peer-scoped (reverts only this peer's ops), and the controller groups
// Loro's per-commit stack items into the steps a reader undoes. Every stream
// of one document is its own LoroDoc with its own controller, and an
// `UndoGroup` makes them one stack: they share the step clock, so a step is
// every commit between two seals in whichever streams took one, and the group
// replays the newest step in each stream that holds a part of it.
import { UndoManager, type LoroDoc } from './wasm-runtime.js';

import type { UndoControllerOptions } from './types.js';

// Loro's time-based merge is permanently disabled. It merges adjacent changes
// by timestamp, across a `sealStep` boundary, so one Ctrl-Z would revert more
// than the last step. Every commit is its own Loro stack item, and the step a
// commit belongs to is the tag `sealStep` advances.
const UNDO_MERGE_INTERVAL_MS = 0;

// Cap on retained undo steps (Loro's default is 100). 200 at typical AEC
// entity sizes is a few hundred KB, well below anything that matters.
const DEFAULT_MAX_UNDO_STEPS = 200;

// Loro caps stack ITEMS, and a step is as many items as it has commits (a
// typed word is one per keystroke). The controller caps STEPS itself (see
// `_floor`), and Loro's item cap is a memory bound behind it. When that one
// binds, Loro drops the oldest items, and the oldest step reverts only the
// part of it that is left.
const ITEMS_PER_STEP_CAP = 64;

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

// Commit origin of a write the app asked to keep off the reader's Undo stack
// (`mutate(fn, { undoable: false })`, `markRead(..., { undoable: false })`):
// an automatic pass the reader did not ask for, which their Undo must not
// revert along with what they did.
export const NON_UNDOABLE_COMMIT_ORIGIN = 'brass.auto';

// Thin wrapper around Loro's UndoManager exposing only what the Document
// needs. Owned by the Document; not part of the public SDK surface.
//
// A step is every local commit between two `sealStep` calls, and the Document
// seals only at a checkpoint, so a step spans a peer's edits whenever two
// people work at once. Every commit is its own Loro stack item, tagged in
// `onPush` with the step it belongs to, and `undo` / `redo` replay every item
// at the top of the stack carrying the top item's tag, so a step reverts whole
// however many commits it took.
//
// Loro's own group cannot hold a step. A peer's edit made after seeing only
// some of a group's commits leaves the group impossible to undo fully (the
// commits the peer saw stay in place, and no later undo removes them), and
// commits ship as they are made, so any group of two or more commits can meet
// that in ordinary collaboration. `undo-concurrent-delivery.test.ts` pins the
// engine behaviour.
//
// One item per commit costs time on a long step: each Loro undo transforms the
// rest of the stack against the remote edits recorded on it, so a step's undo
// grows with its commit count times the remote edits interleaved with the
// stack (`scripts/bench/undo-long-step.mts`).
export class UndoController {
  private readonly _mgr: UndoManager;
  private readonly _maxSteps: number;
  // Holds the tag of the step new local commits join, shared by every stream
  // of the document. `sealStep` advances it.
  private _clock: UndoClock;
  private readonly _hooks: UndoControllerHooks;
  // How many items at the bottom of the redo stack belong to a history a
  // fresh commit in ANOTHER stream has since replaced. Loro clears this
  // stack itself on a commit to this stream only.
  private _redoRetired = 0;
  // While `undo` / `redo` replays a step, the tag the items it pushes onto
  // the opposite stack carry, so the step stays one step in both directions.
  private _replaying: number | null = null;
  // The tag of the item Loro last popped, which the item its replay pushes
  // onto the opposite stack inherits. Loro pops before it pushes.
  private _popped: number | null = null;
  // Set when a replay's Loro call applied an item of another step (see
  // `replay`), and while the controller puts that item back.
  private _foreign: number | null = null;
  private _restoring = false;
  // Whether the replay popped an item of the step it replays.
  private _poppedOwn = false;
  // Tags of the steps on the undo stack, oldest first. Tags only grow up the
  // stack, so a step past the cap is retired by raising `_floor` to its tag:
  // `undo` never replays an item tagged at or below the floor.
  private _undoSteps: number[] = [];
  private _floor = -1;
  // The tag of every item on each Loro stack, bottom first. Once a stack is
  // at Loro's item cap, Loro loses the value `onPush` attaches to each item
  // pushed from then on (loro-crdt 1.13.9 through 1.16.4), so the tag a
  // replay reads comes from here whenever Loro's own reads back empty.
  private _undoTags: number[] = [];
  private _redoTags: number[] = [];
  private readonly _itemCap: number;

  constructor(
    loroDoc: LoroDoc,
    options?: UndoControllerOptions,
    clock: UndoClock = new UndoGroup(),
    hooks: UndoControllerHooks = {},
  ) {
    this._clock = clock;
    this._hooks = hooks;
    const maxSteps = options?.maxUndoSteps ?? DEFAULT_MAX_UNDO_STEPS;
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new RangeError(`maxUndoSteps must be an integer of at least 1, got ${maxSteps}`);
    }
    this._maxSteps = maxSteps;
    this._itemCap = maxSteps * ITEMS_PER_STEP_CAP;
    this._mgr = new UndoManager(loroDoc, {
      mergeInterval: UNDO_MERGE_INTERVAL_MS,
      maxUndoSteps: this._itemCap,
      excludeOriginPrefixes: [PAGING_COMMIT_ORIGIN, NON_UNDOABLE_COMMIT_ORIGIN],
      onPush: (isUndo) => {
        const tag = this._popped ?? this._replaying ?? this._clock.step;
        this._popped = null;
        const ownStep = this._replaying === null || tag === this._replaying;
        if (!ownStep && !this._restoring) this._foreign = tag;
        if (isUndo) {
          if (ownStep && !this._restoring) this.recordUndoStep(tag);
          // A local commit clears Loro's redo stack; a redo's own push does not.
          if (this._replaying === null) {
            this._redoTags = [];
            this._redoRetired = 0;
            this._hooks.onFreshCommit?.();
          }
        }
        const tags = isUndo ? this._undoTags : this._redoTags;
        tags.push(tag);
        if (tags.length > this._itemCap) {
          const dropped = tags.length - this._itemCap;
          tags.splice(0, dropped);
          if (!isUndo) this._redoRetired = Math.max(0, this._redoRetired - dropped);
        }
        this._hooks.onStackChange?.();
        return { value: tag, cursors: [] };
      },
      onPop: (isUndo, meta) => {
        const mirrored = (isUndo ? this._undoTags : this._redoTags).pop();
        const tag = typeof meta.value === 'number' ? meta.value : mirrored;
        this._popped = tag ?? null;
        if (tag === this._replaying && !this._restoring) this._poppedOwn = true;
        if (!isUndo && this._redoRetired > this._redoTags.length) {
          this._redoRetired = this._redoTags.length;
        }
        this._hooks.onStackChange?.();
      },
    });
  }

  private topTag(dir: 'undo' | 'redo'): number | undefined {
    const value = dir === 'undo' ? this._mgr.topUndoValue() : this._mgr.topRedoValue();
    if (typeof value === 'number') return value;
    const tags = dir === 'undo' ? this._undoTags : this._redoTags;
    return tags[tags.length - 1];
  }

  private recordUndoStep(tag: number): void {
    if (this._undoSteps[this._undoSteps.length - 1] === tag) return;
    this._undoSteps.push(tag);
    while (this._undoSteps.length > this._maxSteps) {
      this._floor = Math.max(this._floor, this._undoSteps.shift()!);
    }
  }

  // `beforeEach` runs before every Loro undo / redo the step takes, since each
  // one is its own commit (the Document tags each with its commit origin).
  undo(beforeEach?: () => void): boolean {
    return this.replay('undo', beforeEach);
  }

  redo(beforeEach?: () => void): boolean {
    return this.replay('redo', beforeEach);
  }

  // Replay this stream's part of step `tag`, which the group chose as the
  // document's newest (undo) or most recently undone (redo) step.
  replayStep(dir: 'undo' | 'redo', tag: number, beforeEach?: () => void): boolean {
    return this.replay(dir, beforeEach, tag);
  }

  // The tag of the step this stream would replay next, or `undefined` when
  // it has none: below the floor for undo, and past the retired items for
  // redo.
  peek(dir: 'undo' | 'redo'): number | undefined {
    const tag = this.topTag(dir);
    if (typeof tag !== 'number') return undefined;
    if (dir === 'undo') return tag > this._floor ? tag : undefined;
    return this.hasLiveRedo() ? tag : undefined;
  }

  // Tags at or below this have left the undo stack (see `_floor`).
  get floor(): number {
    return this._floor;
  }

  // Move to another document's step clock. Called when a stream joins its
  // document, before it has taken any local commit.
  useClock(clock: UndoClock): void {
    this._clock = clock;
  }

  // A fresh commit in another stream of the document: the steps on this
  // stream's redo stack belong to the history that commit replaced.
  retireRedo(): void {
    this._redoRetired = this._redoTags.length;
  }

  private hasLiveRedo(): boolean {
    return this._redoRetired === 0 || this._redoTags.length > this._redoRetired;
  }

  // Loro skips an item whose replay would change nothing visible (a peer
  // deleted what it edited) and pops the next one in the same call, which can
  // belong to an older step or sit below `_floor`. The controller puts such an
  // item straight back through the opposite stack, under its own tag, so one
  // call replays one step. A step whose every item Loro skipped has still left
  // the stack, so it counts as replayed and the call returns `true`.
  private replay(dir: 'undo' | 'redo', beforeEach?: () => void, chosen?: number): boolean {
    const top = (): number | undefined => this.topTag(dir);
    const tag = chosen ?? this.peek(dir);
    this._poppedOwn = false;
    try {
      if (typeof tag === 'number' && top() === tag) {
        this._replaying = tag;
        while (top() === tag) {
          beforeEach?.();
          const moved = dir === 'undo' ? this._mgr.undo() : this._mgr.redo();
          if (this._foreign !== null) {
            this._restoring = true;
            beforeEach?.();
            if (dir === 'undo') this._mgr.redo();
            else this._mgr.undo();
            this._restoring = false;
            this._foreign = null;
          }
          if (!moved) break;
        }
        if (dir === 'undo' && this._undoSteps[this._undoSteps.length - 1] === tag) {
          this._undoSteps.pop();
        }
      }
    } finally {
      this._replaying = null;
      this._restoring = false;
      this._foreign = null;
      this._popped = null;
      // The next local commit starts a step of its own, so it never joins the
      // step just replayed (an edit after a redo undoes on its own).
      this._clock.step += 1;
    }
    return this._poppedOwn;
  }

  canUndo(): boolean {
    const tag = this.topTag('undo');
    return tag !== undefined && tag > this._floor && this._mgr.canUndo();
  }

  canRedo(): boolean {
    return this._mgr.canRedo() && this.hasLiveRedo();
  }

  // Seal the current undo step: commits after this one join a new step.
  // `createCheckpoint` and the auto-checkpoint scheduler call this so every
  // checkpoint is a Ctrl-Z boundary. Idempotent: an empty step has no items.
  sealStep(): void {
    this._clock.step += 1;
  }

  // Drop both stacks. Called by `_applySnapshot`: the prior entries reference a
  // state the new snapshot superseded.
  clear(): void {
    this._mgr.clear();
    this._undoSteps = [];
    this._undoTags = [];
    this._redoTags = [];
    this._redoRetired = 0;
    this._clock.step += 1;
  }

  free(): void {
    this._mgr.free();
  }
}

// The step clock a controller tags its commits with.
export interface UndoClock {
  step: number;
}

export interface UndoControllerHooks {
  // A local commit outside a replay landed on the undo stack.
  onFreshCommit?: () => void;
  // An item was pushed onto or popped off either stack. Runs inside Loro's
  // callback, so it must not call back into the UndoManager.
  onStackChange?: () => void;
}

// One stream's place in a document's undo group: the Document that holds the
// stream's state.
export interface UndoGroupMember {
  /** @internal This stream's controller, or `null` when it has no CRDT. */
  _undoController(): UndoController | null;
  /** @internal Whether this stream may replay a step now: it takes writes
   *  and is not showing a version. */
  _undoEligible(): boolean;
  /** @internal True inside a `mutate` callback on this stream. */
  _undoMutating(): boolean;
  /** @internal Replay this stream's part of step `tag`. */
  _replayUndoStep(dir: 'undo' | 'redo', tag: number): boolean;
}

export interface UndoGroupOwner {
  // Whether the document refuses every replay now (closed, or showing a
  // version), whatever each stream's own state.
  blocked(): boolean;
  // Re-read the document's undo state for `subscribeUndoState`.
  notify(): void;
  // A stream other than the owner's took a fresh undoable commit.
  memberCommitted(): void;
}

// The undo stack of one document, across its streams. The step clock is
// shared, so tags only grow over time document-wide: the newest step is the
// highest tag on top of any stream's undo stack, and the most recently undone
// step is the lowest tag on top of any redo stack. Undo replays that tag in
// every stream whose top carries it, so a step spanning streams reverts whole.
export class UndoGroup implements UndoClock {
  step = 0;
  private readonly _members = new Set<UndoGroupMember>();
  private _owner: { member: UndoGroupMember; hooks: UndoGroupOwner } | null = null;
  private _notifyQueued = false;

  setOwner(member: UndoGroupMember, hooks: UndoGroupOwner): void {
    this._owner = { member, hooks };
    this._members.add(member);
  }

  isOwner(member: UndoGroupMember): boolean {
    return this._owner?.member === member;
  }

  add(member: UndoGroupMember): void {
    this._members.add(member);
  }

  delete(member: UndoGroupMember): void {
    this._members.delete(member);
  }

  seal(): void {
    this.step += 1;
  }

  // A non-owner stream's stacks moved. Deferred, because the move is reported
  // from inside the UndoManager, which the re-read calls back into.
  changed(): void {
    if (this._owner === null || this._notifyQueued) return;
    this._notifyQueued = true;
    queueMicrotask(() => {
      this._notifyQueued = false;
      this._owner?.hooks.notify();
    });
  }

  // A fresh commit replaces the history every redo stack in the document
  // undoes back into, not only the stack of the stream it landed in.
  freshCommit(from: UndoGroupMember): void {
    for (const member of this._members) {
      if (member !== from) member._undoController()?.retireRedo();
    }
    if (this._owner !== null && this._owner.member !== from) {
      this._owner.hooks.memberCommitted();
    }
  }

  private eligible(): Array<{ member: UndoGroupMember; ctl: UndoController }> {
    const out: Array<{ member: UndoGroupMember; ctl: UndoController }> = [];
    if (this._owner?.hooks.blocked()) return out;
    for (const member of this._members) {
      const ctl = member._undoController();
      if (ctl !== null && member._undoEligible()) out.push({ member, ctl });
    }
    return out;
  }

  // Each stream retires its oldest steps past its own cap, and a step one
  // stream has retired is retired in every stream, so no Undo reverts part of
  // one.
  private floor(): number {
    let floor = -1;
    for (const member of this._members) {
      const ctl = member._undoController();
      if (ctl !== null) floor = Math.max(floor, ctl.floor);
    }
    return floor;
  }

  private next(dir: 'undo' | 'redo'): number | undefined {
    let next: number | undefined;
    for (const { ctl } of this.eligible()) {
      const tag = ctl.peek(dir);
      if (tag === undefined) continue;
      if (next === undefined || (dir === 'undo' ? tag > next : tag < next)) next = tag;
    }
    if (dir === 'undo' && next !== undefined && next <= this.floor()) return undefined;
    return next;
  }

  canUndo(): boolean {
    const floor = this.floor();
    return this.eligible().some(({ ctl }) => {
      const tag = ctl.peek('undo');
      return tag !== undefined && tag > floor && ctl.canUndo();
    });
  }

  canRedo(): boolean {
    return this.eligible().some(({ ctl }) => ctl.canRedo());
  }

  // True when a step was replayed. Refuses inside any stream's `mutate`
  // callback, whose open transaction holds writes the replay would commit
  // outside the op it ships.
  replay(dir: 'undo' | 'redo'): boolean {
    for (const member of this._members) {
      if (member._undoMutating()) return false;
    }
    const tag = this.next(dir);
    if (tag === undefined) return false;
    let replayed = false;
    for (const { member, ctl } of this.eligible()) {
      if (ctl.peek(dir) !== tag) continue;
      if (member._replayUndoStep(dir, tag)) replayed = true;
    }
    return replayed;
  }
}
