// Document lifecycle signals: server-pushed listener-fanout surfaces a
// Document exposes, separate from the CRDT state it wraps. Pure subscriber
// registries with a load-bearing emit discipline:
//
//   - `GoneSignal`       fire-once-then-cache (a doc is evicted once)
//   - `WorkStatusSignal` latest-retained, re-emit per phase
//   - `DriveStatusSignal` latest-retained, fire-on-attach, dedup-on-emit

import { createEmitter } from './emitter.js';

// Reason a Document's underlying doc was evicted. Mirrors the `doc_gone`
// frame's `reason`. New literals land
// here as the platform grows transitions that evict open subscribers.
// `moved`: the doc changed organization or project, so its access gate
// changed and open subscribers re-establish under the new location.
export type DocumentGoneReason = 'deleted' | 'moved';

export type DocumentGoneListener = (reason: DocumentGoneReason) => void;
export type DocumentGoneUnsubscribe = () => void;

// Opaque status of slow server-side work (hydration, extraction, push).
// Mirrors the wire shape of the server's status frame. The app
// renders `message` verbatim, draws a bar from `progress`, and waits while
// `pending`. No kind / phase / error code: the server owns all wording and can
// change phases without any app change.
export interface DocumentWorkStatus {
  message: string;
  progress?: number;
  pending: boolean;
  // Whether this work locks editing. Inbound work (hydration, extraction)
  // replaces content, so the doc is read-only until it lands
  // (`blocking: true`); an outbound push leaves content untouched, so editing
  // stays open (`blocking: false`). Optional; absence is treated as blocking.
  // `doc.readOnly` already folds this in, so apps rarely read it directly.
  blocking?: boolean;
}

export type DocumentStatusListener = (status: DocumentWorkStatus) => void;
export type DocumentStatusUnsubscribe = () => void;

// Coarse divergence state of a drive-linked doc vs its source. Mirrors the
// server's `tracking_state`. The
// app reads `state` to decide which affordance to show, never to pick wording
// (that is server-authored `label` / `detail`).
export type DocumentDriveTrackingState =
  | 'unhydrated'
  | 'synced'
  | 'behind'
  | 'ahead'
  | 'diverged';

// Which way the mirror flows. `two_way` links round-trip; `import_only` links
// are one-directional (edits stay in Brass, no publish-back path). An app
// reads this to decide whether to show a Publish affordance at all.
export type DriveMirrorDirection = 'two_way' | 'import_only';

// The drive sync state of an open document. Present only on drive-linked
// docs; `null` otherwise. Lets an app show "you have unpublished edits"
// without polling, while the hosted toolbar owns publishing itself. Words are
// server-authored (`label` / `detail`, rendered verbatim); the app branches
// only on `state` / `canPush`.
export interface DocumentDriveStatus {
  // Adapter type token; an app may key an icon off it. The human label is
  // `driveName`, so an app never maps the type to a vendor name itself.
  driveType: string;
  // The drive's user-facing name, server-authored and rendered verbatim.
  driveName: string;
  // The divergence state. `ahead` / `diverged` mean unpublished local edits.
  state: DocumentDriveTrackingState;
  // True when publishing would do something now, as the server decides it:
  // edits the drive takes and something here can write, or a rename or move
  // to carry, on an unbroken link with no publish in flight. The cue to
  // surface a "Publish" affordance.
  canPush: boolean;
  // Server-authored short pill text (`null` when nothing worth surfacing).
  label: string | null;
  // Server-authored detail sentence for a tooltip (`null` when none).
  detail: string | null;
  // The link's backing connection was removed; the doc can no longer sync. The
  // app surfaces a terminal "reconnect needed" state.
  broken: boolean;
  // True when a push overwrites the source wholesale instead of 3-way merging
  // (the file-roundtrip path), so an app can warn that the source's newer
  // version will be replaced, not merged.
  pushReplacesRemote: boolean;
  /** @internal True when the drive keeps every prior version of the item,
   *  so a version a publish replaces stays in the item's history on the
   *  drive. The SDK's own drive surface words its publish confirm from it. */
  keepsPriorVersions: boolean;
  // Whether the link round-trips (`two_way`) or only imports (`import_only`).
  // An `import_only` link publishes no content, so `canPush` is true there
  // only for a rename or a move; an app surfaces the class so a one-way
  // import doesn't read as a live two-way mirror.
  mirrorDirection: DriveMirrorDirection;
  // Current external head ref, empty when the adapter could not produce one.
  ref: string;
  // ISO timestamp the ref was last refreshed, empty on a fresh stub.
  refUpdatedAt: string;
  // The source item's display name, for a "linked to <name>" tooltip.
  itemName: string;
  // Deep link to the source, so a link indicator can open it.
  itemUrl: string;
  // True while a push is in flight (submitted, running server-side, not yet
  // confirmed). A push is asynchronous, so `state` stays `ahead` until it
  // lands; an indicator reads this to hold a "Publishing..." state and hide
  // the Publish affordance rather than re-deriving it. `detail` carries the
  // server-authored progress line while it is `true`.
  publishing: boolean;
  /** The drive's own words about the file the last publish delivered, set
   *  only where the drive answered that it could not read it. The publish
   *  succeeded and the artifact exists; the drive's reader rejects it, which
   *  a person otherwise meets as an error inside the drive. */
  sourceUnreadable?: string;
}

export type DocumentDriveStatusListener = (
  status: DocumentDriveStatus,
) => void;
export type DocumentDriveStatusUnsubscribe = () => void;

// Where a document that mirrors nothing can be published: the drive its
// project is linked to, which takes it as a NEW file. A drive-linked
// document has `driveStatus` and no targets; this is the state before the
// first publish, which is what a document added to a linked project (an
// upload, or one an app created there) sits in.
//
// Words are server-authored (`detail`, rendered verbatim), as everywhere
// else a drive is described.
export interface DrivePublishTarget {
  // Adapter type token; an app may key an icon off it.
  driveType: string;
  // The drive's user-facing name.
  driveName: string;
  // What the linked container is called on the drive, so a surface can say
  // where the file lands.
  containerName: string;
  // The sentence a publish affordance renders, verbatim.
  detail: string;
  // True while a publish is in flight, so the affordance holds rather than
  // inviting a second artifact.
  publishing: boolean;
  // The last publish attempt failed, in which case `detail` carries the
  // server's account of why rather than the resting sentence.
  publishFailed: boolean;
  // The drive does not take this document's file; `detail` says why, and
  // there is nothing to publish.
  unpublishable: boolean;
}

// Each signal is a `createEmitter` composed with the retain / attach / dedup
// policy its wire event needs, wrapped in a small class only to keep the
// domain-named methods (`mark`, `emit`, `status`, `clearListeners`) the
// Document calls. The shared emit discipline (swallow-and-log, fire-on-attach
// in a microtask, retain the last value) lives in the primitive; the class
// picks the options.

// Fire-once-then-cache signal for `doc_gone`: listeners registered AFTER the
// event still fire exactly once on attach (the `Promise`-resolution pattern),
// so callback-wiring after the WS frame may have landed has no race. `mark` is
// idempotent (both `doc:<id>` and `presence:doc:<id>` fan out a frame, so the
// one-shot collapses them to a single listener fire).
export class GoneSignal {
  private readonly _emitter = createEmitter<DocumentGoneReason>({
    fireOnAttach: true,
    retain: 'oneShot',
    onError: (err) => {
      // A consumer throw must not strand the others or break the WS router.
      console.error('[Brass] onGone listener threw:', err);
    },
  });

  get reason(): DocumentGoneReason | null {
    return this._emitter.retained ?? null;
  }

  on(cb: DocumentGoneListener): DocumentGoneUnsubscribe {
    return this._emitter.on(cb);
  }

  mark(reason: DocumentGoneReason): void {
    this._emitter.emit(reason);
  }

  // Drop app-side listeners (suspend / close). The cached reason is NOT
  // cleared: a `_markGone` that already fired stays terminal across a suspend.
  clearListeners(): void {
    this._emitter.clear();
  }
}

const NO_WORK_STATUS: DocumentWorkStatus = { message: '', pending: false, blocking: false };

// Latest-retained, re-emit-per-phase signal for `doc_status`. Not one-shot:
// phases arrive repeatedly until terminal (`pending: false`), and the latest
// is retained so a late subscriber still sees the final state.
//
// A notice is the SDK's own status, raised over the platform's work rather
// than replacing it: `status` reads the notice while one is up, and `work`
// keeps answering what the platform reported, which is what every SDK-side
// decision about pending work reads. A work status arriving under a notice
// still reaches the listeners (the SDK's own import waiters attach here and
// wait for a terminal one), and the notice is re-emitted straight after it so
// the last thing a listener hears matches `status`.
export class WorkStatusSignal {
  private readonly _emitter = createEmitter<DocumentWorkStatus>({
    fireOnAttach: true,
    retain: 'latest',
    onError: (err) => {
      console.error('[Brass] onStatus listener threw:', err);
    },
  });
  private _work: DocumentWorkStatus | null = null;
  private _notice: DocumentWorkStatus | null = null;

  get status(): DocumentWorkStatus | null {
    return this._notice ?? this._work;
  }

  get work(): DocumentWorkStatus | null {
    return this._work;
  }

  get notice(): DocumentWorkStatus | null {
    return this._notice;
  }

  on(cb: DocumentStatusListener): DocumentStatusUnsubscribe {
    return this._emitter.on(cb);
  }

  emit(status: DocumentWorkStatus): void {
    this._work = status;
    this._emitter.emit(status);
    if (this._notice !== null) this._emitter.emit(this._notice);
  }

  // Raise or clear the notice. Clearing hands listeners the work status it
  // covered, or a terminal empty one when there is none, since a listener
  // takes a status rather than `null`.
  setNotice(notice: DocumentWorkStatus | null): void {
    if (notice === this._notice) return;
    this._notice = notice;
    this._emitter.emit(notice ?? this._work ?? NO_WORK_STATUS);
  }

  clearListeners(): void {
    this._emitter.clear();
  }
}

// Latest-retained, fire-on-attach signal for `doc_drive_status`. Like
// `WorkStatusSignal`, but `emit` short-circuits when the new status
// deep-equals the retained one: drive status fans out on *every* METADATA row
// change (rename, thumbnail, edit), so the equality gate keeps `onDriveStatus`
// from re-firing when the tracking state didn't move.
export class DriveStatusSignal {
  private readonly _emitter = createEmitter<DocumentDriveStatus>({
    fireOnAttach: true,
    retain: 'latest',
    equals: driveStatusEqual,
    onError: (err) => {
      console.error('[Brass] onDriveStatus listener threw:', err);
    },
  });

  get status(): DocumentDriveStatus | null {
    return this._emitter.retained ?? null;
  }

  on(cb: DocumentDriveStatusListener): DocumentDriveStatusUnsubscribe {
    return this._emitter.on(cb);
  }

  emit(status: DocumentDriveStatus): void {
    this._emitter.emit(status);
  }

  clearListeners(): void {
    this._emitter.clear();
  }
}

// How the publish of a document that mirrors nothing is going. Server-
// authored: `detail` replaces the target's resting sentence while present,
// and is rendered verbatim.
export interface DrivePublishState {
  // A publish is running on the server.
  publishing: boolean;
  // The last publish attempt failed; `detail` says what the server made of
  // it.
  failed: boolean;
  // The sentence to render, or null to fall back to the target's resting
  // copy.
  detail: string | null;
}

const RESTING_PUBLISH: DrivePublishState = {
  publishing: false,
  failed: false,
  detail: null,
};

// Where an unlinked document can be published, and how its publish is going.
//
// The TARGETS are seeded from the join alone, because the set only changes
// when the document becomes a mirror and the drive status arriving is that
// event, so the open factory clears them when one does. The STATE moves
// while the document is open: the first publish creates the artifact, so
// until it lands there is no drive status to report progress or failure
// through, and a `doc_drive_publish` frame carries it instead.
export class DrivePublishTargetSignal {
  private _target: DrivePublishTarget | null = null;
  private _state: DrivePublishState = RESTING_PUBLISH;
  private readonly _listeners = new Set<() => void>();

  get target(): DrivePublishTarget | null {
    return this._target;
  }

  get state(): DrivePublishState {
    return this._state;
  }

  set(target: DrivePublishTarget | null): void {
    this._target = target;
    // The join states the same thing the frames do, so a reopen starts from
    // the server's current answer rather than from the last frame's.
    this._state = {
      publishing: target?.publishing === true,
      failed: target?.publishFailed === true,
      detail: null,
    };
    this._notify();
  }

  setState(state: DrivePublishState): void {
    this._state = state;
    this._notify();
  }

  onState(cb: () => void): () => void {
    this._listeners.add(cb);
    return () => {
      this._listeners.delete(cb);
    };
  }

  // Paired with the other signals' method of the same name: a parked or
  // closed Document must not reach an app callback registered by a session
  // that is over.
  clearListeners(): void {
    this._listeners.clear();
  }

  // Both mutators notify. A reader renders the targets and the state
  // together, so a change to either is a change to what it draws, and one
  // silent mutator would leave that reader showing the other half.
  private _notify(): void {
    for (const cb of this._listeners) cb();
  }
}

// Field-by-field equality for the drive status. The shape is flat (all
// scalars), so a key compare suffices; explicit rather than JSON.stringify so
// a future non-scalar field forces a conscious update here.
function driveStatusEqual(
  a: DocumentDriveStatus,
  b: DocumentDriveStatus,
): boolean {
  return (
    a.driveType === b.driveType &&
    a.driveName === b.driveName &&
    a.state === b.state &&
    a.canPush === b.canPush &&
    a.label === b.label &&
    a.detail === b.detail &&
    a.broken === b.broken &&
    a.pushReplacesRemote === b.pushReplacesRemote &&
    a.keepsPriorVersions === b.keepsPriorVersions &&
    a.mirrorDirection === b.mirrorDirection &&
    a.ref === b.ref &&
    a.refUpdatedAt === b.refUpdatedAt &&
    a.publishing === b.publishing &&
    a.sourceUnreadable === b.sourceUnreadable &&
    a.itemName === b.itemName &&
    a.itemUrl === b.itemUrl
  );
}
