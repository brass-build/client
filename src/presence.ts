// Document-scoped presence ("who is here right now"), reached as
// `doc.presence`. Owns one WS subscription on `presence:doc:<doc_id>`
// multiplexed onto the shared `BrassWsClient`: tracks the roster of
// other participants (from `presence_snapshot` + join/update/leave
// frames), publishes this client's presence via `set(...)` (shallow
// local merge, throttled outbound), and notifies `on('change')`. The
// server stores what it is sent verbatim, so the merge happens here.

import { createEmitter } from './emitter.js';

// `set(...)` is debounced to at most one `presence` frame per interval
// (leading edge fires immediately, trailing send carries merges from
// the window). 100 ms = 10 Hz: low fanout cost, smooth interpolation.
export const PRESENCE_PUBLISH_INTERVAL_MS = 100;

/**
 * The largest a single presence layer (`state` or `ext`) may serialise to.
 *
 * The platform caps each layer at this and drops a frame whose layer is
 * over, so a payload past it reaches no peer. Roughly 130 to 140 entity ids
 * in `state.selection`, which an ordinary marquee select crosses, so measure
 * against it whenever what you publish scales with what the user picked.
 */
export const PRESENCE_LAYER_MAX_BYTES = 2048;

const PRESENCE_TOPIC_PREFIX = 'presence:doc:';

const TEXT_ENCODER = new TextEncoder();

// Serialised UTF-8 byte length of one layer, measured the same way the
// platform measures it. A non-serialisable value (circular, a BigInt) reads
// as over the cap rather than throwing out of the publish path, since a
// frame carrying it could not be sent either way.
function presenceLayerBytes(layer: Record<string, unknown>): number {
  let json: string;
  try {
    json = JSON.stringify(layer);
  } catch {
    return Number.POSITIVE_INFINITY;
  }
  return TEXT_ENCODER.encode(json).length;
}

// The outgoing payload as one comparable string, or null when it cannot be
// serialised. Null reads as "different" at the call site, so a comparison
// that cannot be answered sends the frame rather than skipping it.
function presencePayloadKey(presence: PresenceSetInput): string | null {
  try {
    return JSON.stringify(presence);
  } catch {
    return null;
  }
}

// Reserved-by-convention sub-keys on the presence `state` block, so
// two apps on the same document agree on each key's meaning even when
// one is 2D (cursor only) and another 3D (camera + cursor). All keys
// optional; an app sets only what it has.
//
// Coordinates are the platform standard: meters, right-handed, Z-up,
// document world space. Map your engine's coordinates in before `set`
// and back out when rendering remotes.
//
// App-specific state (tool, chat bubble, typing indicator) goes under
// `ext` instead, namespaced out of the cross-app conventions.
export interface PresenceState {
  /** Primary pointer position. Use for "this is where my cursor
   * is right now" in a 2D or 3D editor; omit if the app has no
   * cursor concept. */
  cursor?: { x: number; y: number; z: number };
  /** Where the user is looking from in 3D. Use to render a
   * "Bob is viewing the south facade" gizmo at the camera's
   * position. Omit in 2D apps; use `cursor` instead. */
  camera?: {
    position: { x: number; y: number; z: number };
    target?: { x: number; y: number; z: number };
  };
  /** Entity ids the user has selected. Use to highlight remote
   * selections so collaborators see what each other is working on. */
  selection?: string[];
}

// A live participant on a presence topic. Keyed on `connectionId` (one
// per tab / device); identity fields (`sub`, `displayName`, `color`)
// are server-stamped. The `Partial<PresenceState> & Record<...>`
// intersection on `state` types `state.cursor?.x` as `number |
// undefined` while still allowing arbitrary `state[key]` (typed
// `unknown`). `ext` is the app-namespaced blob. Both default to `{}`
// before the participant's first `set(...)`.
export interface PresenceParticipant {
  connectionId: string;
  sub: string;
  displayName: string;
  avatarUrl: string;
  color: string;
  joinedAt: string;
  lastSeen: string;
  state: Partial<PresenceState> & Record<string, unknown>;
  ext: Record<string, unknown>;
}

// The partial payload passed to `presence.set(...)`. Either layer may
// be present; each is shallow-merged into the client's current self
// payload, so `set({ cursor })` then `set({ camera })` keeps both.
export interface PresenceSetInput {
  state?: Record<string, unknown>;
  ext?: Record<string, unknown>;
}

export type PresenceChangeListener = (
  roster: PresenceParticipant[],
) => void;

/** The two independently capped layers of a presence payload. */
export type PresenceLayer = 'state' | 'ext';

/**
 * Whether this client's presence is reaching its peers.
 *
 * A layer larger than `PRESENCE_LAYER_MAX_BYTES` is withheld from the wire,
 * so the roster everyone else renders keeps the last value that fit. Read
 * `status` for the current answer, or `onStatus` to be told when it moves.
 */
export interface PresenceStatus {
  /** True while some layer is too large to publish. */
  oversize: boolean;
  /** The layers being withheld, `state` before `ext`. Empty when
   *  `oversize` is false. */
  withheld: PresenceLayer[];
}

export type PresenceStatusListener = (status: PresenceStatus) => void;

const PRESENCE_STATUS_OK: PresenceStatus = { oversize: false, withheld: [] };

function statusEqual(a: PresenceStatus, b: PresenceStatus): boolean {
  return (
    a.oversize === b.oversize &&
    a.withheld.length === b.withheld.length &&
    a.withheld.every((layer, i) => layer === b.withheld[i])
  );
}

// The public shape attached as `doc.presence`. An interface (not the
// concrete class) so `documents.ts` can type the field without
// importing the implementation.
export interface PresenceClient {
  // Publish a partial update; shallow-merged locally, throttled onto the wire.
  set(input: PresenceSetInput): void;
  // Subscribe to roster changes (snapshot, join, update, leave). Fires
  // once on subscribe with the current roster when peers are already
  // present, then on every change. Returns an unsubscribe function;
  // equivalent to `.off` with the same listener.
  on(event: 'change', listener: PresenceChangeListener): () => void;
  // Detach a listener registered with `.on`. Idempotent. For the
  // `addEventListener` / `removeEventListener` style where the listener
  // reference is what's kept at teardown.
  off(event: 'change', listener: PresenceChangeListener): void;
  // Subscribe to whether this client's presence is reaching its peers.
  // Fires on attach with the current status, then on every change to it,
  // never per `set(...)`: a publisher whose every update is too large
  // reports the condition once, not at 10 Hz. Returns an unsubscribe
  // function.
  onStatus(listener: PresenceStatusListener): () => void;
  // Whether this client's presence is reaching its peers, right now.
  readonly status: PresenceStatus;
  // The current roster of OTHER live participants (self is not in it; read `self`).
  readonly roster: PresenceParticipant[];
  // This client's own current presence payload, as last set.
  readonly self: {
    state: Record<string, unknown>;
    ext: Record<string, unknown>;
  };
  // Unsubscribe the topic and drop all roster state + listeners. Also
  // called automatically when the owning Document is closed.
  leave(): void;
  /**
   * @internal Called when the owning Document parks (`Document._suspend`).
   * Drops app-registered `change` and `status` listeners so a callback
   * wired in the parked session does not keep firing on remote presence
   * frames after the app has closed the doc, and gates the outbound publish
   * path so a parked doc stops advertising this client's cursor. Keeps the WS
   * subscription and roster alive so a resumed open is seamless. Not
   * `leave()`: parking is reversible and the subscription must survive it.
   */
  _suspendListeners(): void;
  /**
   * @internal Called when the owning Document resumes (`Document._resume`).
   * Reopens the outbound gate `_suspendListeners` closed and re-advertises
   * this client's retained presence so peers restore its cursor on the
   * resumed open, mirroring the reconnect-snapshot republish.
   */
  _resumeListeners(): void;
}

// Structural subset of `BrassWsClient` the controller needs. Matches
// `OpenDocumentWsClient` in `open-document.ts` so the same shared
// transport instance is passed straight through.
export interface PresenceWsClient {
  subscribe(topic: string, callback: (frame: unknown) => void): () => void;
  send(frame: unknown): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Map a server-stamped (snake_case) participant from the wire onto
// the camelCase `PresenceParticipant` SDK consumers see. Returns null
// for a structurally invalid entry so one bad row in a snapshot does
// not poison the whole roster.
function wireToParticipant(raw: unknown): PresenceParticipant | null {
  if (!isObject(raw)) return null;
  const connectionId = raw['connection_id'];
  const sub = raw['sub'];
  const displayName = raw['display_name'];
  const avatarUrl = raw['avatar_url'];
  const color = raw['color'];
  const joinedAt = raw['joined_at'];
  const lastSeen = raw['last_seen'];
  if (
    typeof connectionId !== 'string' ||
    typeof sub !== 'string' ||
    typeof displayName !== 'string' ||
    typeof color !== 'string' ||
    typeof joinedAt !== 'string' ||
    typeof lastSeen !== 'string'
  ) {
    return null;
  }
  const presence = raw['presence'];
  const { state, ext } = splitPresencePayload(presence);
  return {
    connectionId,
    sub,
    displayName,
    avatarUrl: typeof avatarUrl === 'string' ? avatarUrl : '',
    color,
    joinedAt,
    lastSeen,
    state,
    ext,
  };
}

// Pull `state` / `ext` out of a wire `presence` payload, defaulting
// each to an empty object. Tolerates a missing or malformed payload.
function splitPresencePayload(payload: unknown): {
  state: Record<string, unknown>;
  ext: Record<string, unknown>;
} {
  if (!isObject(payload)) return { state: {}, ext: {} };
  const rawState = payload['state'];
  const rawExt = payload['ext'];
  return {
    state: isObject(rawState) ? rawState : {},
    ext: isObject(rawExt) ? rawExt : {},
  };
}

class PresenceController implements PresenceClient {
  private readonly _topic: string;
  private readonly _roster = new Map<string, PresenceParticipant>();
  private readonly _listeners = new Set<PresenceChangeListener>();
  private _selfState: Record<string, unknown> = {};
  private _selfExt: Record<string, unknown> = {};
  private _unsub: (() => void) | null = null;
  private _throttleTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastSentAt = 0;
  private _closed = false;
  // The last value of each layer that reached the wire, or null for a layer
  // that has never been published. A withheld layer re-sends its entry: the
  // server stores the payload verbatim, so omitting the layer would clear it
  // from every peer's roster rather than leaving it at its last good value.
  private _sentState: Record<string, unknown> | null = null;
  private _sentExt: Record<string, unknown> | null = null;
  // The payload of the last frame this connection published, so a tick that
  // resolves to the same one can be skipped. Distinct from the two layers
  // above, which are the last values that FIT and are what a withheld layer
  // falls back to.
  private _sentPayloadKey: string | null = null;
  // Set by the two paths that republish because the server's copy of this
  // client's presence is gone (a re-subscribe rewrites the row empty, and a
  // resumed open re-advertises after a park). The frame they need is exactly
  // the one the comparison above would skip, so it takes precedence for one
  // send.
  private _republishPending = false;
  private readonly _statusEmitter = createEmitter<PresenceStatus>({
    fireOnAttach: true,
    retain: 'latest',
    // Publishing runs at 10 Hz, and an app that overflows a layer usually
    // overflows it on every update, so the gate is what turns a per-update
    // condition into the edge an app can act on.
    equals: statusEqual,
    onError: (err) => {
      console.error('[Brass] presence onStatus listener threw:', err);
    },
  });
  // Set while the owning Document is parked (`_suspendListeners`). Gates the
  // outbound publish path so a parked doc advertises nothing, whether from a
  // late `set(...)` or from the reconnect-snapshot republish (the WS
  // subscription stays attached across a park, so those frames keep arriving).
  // `_resumeListeners` clears it. Distinct from `_closed`: parking is
  // reversible, so inbound roster tracking and `_selfState` are kept.
  private _suspended = false;

  constructor(
    private readonly _wsClient: PresenceWsClient,
    docId: string,
    // The branch this presence channel scopes to. Presence is per
    // (document, branch): two users on different branches of the
    // same doc do not see each other's cursors.
    branchId: string,
  ) {
    this._topic = `${PRESENCE_TOPIC_PREFIX}${docId}:${branchId}`;
    // Seed the retained status so `status` reads and a fire-on-attach
    // `onStatus` both answer before the first `set(...)`.
    this._statusEmitter.emit(PRESENCE_STATUS_OK);
    this._unsub = this._wsClient.subscribe(this._topic, (frame) =>
      this._onFrame(frame),
    );
  }

  get roster(): PresenceParticipant[] {
    return [...this._roster.values()];
  }

  get status(): PresenceStatus {
    return this._statusEmitter.retained ?? PRESENCE_STATUS_OK;
  }

  onStatus(listener: PresenceStatusListener): () => void {
    return this._statusEmitter.on(listener);
  }

  get self(): {
    state: Record<string, unknown>;
    ext: Record<string, unknown>;
  } {
    return { state: this._selfState, ext: this._selfExt };
  }

  set(input: PresenceSetInput): void {
    if (this._closed) return;
    if (input.state !== undefined) {
      this._selfState = { ...this._selfState, ...input.state };
    }
    if (input.ext !== undefined) {
      this._selfExt = { ...this._selfExt, ...input.ext };
    }
    this._scheduleSend();
  }

  on(event: 'change', listener: PresenceChangeListener): () => void {
    if (event !== 'change') {
      // Only `change` exists today. Returning a no-op unsubscribe
      // (rather than throwing) keeps a forward-compatible call site
      // from breaking against an older SDK build.
      return () => {};
    }
    this._listeners.add(listener);
    // Deliver the current roster on attach when peers are already here, so
    // a listener wired after the `presence_snapshot` landed (the common
    // case: opening a document others are already in) paints them instead
    // of waiting for their next move. Matches the fire-on-attach contract
    // the SDK's other subscribe surfaces hold when they have state to
    // deliver (`onGone`, `onStatus`). An empty roster is the consumer's
    // default paint, so it needs no initial fire.
    if (this._roster.size > 0) {
      try {
        listener(this.roster);
      } catch {
        // A throwing initial callback must not strand the registration.
      }
    }
    return () => {
      this._listeners.delete(listener);
    };
  }

  off(event: 'change', listener: PresenceChangeListener): void {
    if (event !== 'change') return;
    this._listeners.delete(listener);
  }

  leave(): void {
    if (this._closed) return;
    this._closed = true;
    if (this._throttleTimer !== null) {
      clearTimeout(this._throttleTimer);
      this._throttleTimer = null;
    }
    if (this._unsub) {
      try {
        this._unsub();
      } catch {
        // Detaching an already-detached subscription is fine; swallow.
      }
      this._unsub = null;
    }
    this._roster.clear();
    this._listeners.clear();
    this._statusEmitter.clear();
  }

  _suspendListeners(): void {
    // Drop the app-registered change listeners and gate the outbound publish
    // path; keep the WS subscription and roster so a resumed open (which does
    // not re-create the controller) is seamless and a re-registered
    // `on('change')` fires immediately with the still-current roster. The gate
    // is what stops a parked doc advertising this client's cursor: cancelling
    // the pending trailing send alone is not enough, because a `set(...)` after
    // park or the republish `_applySnapshot` fires on a reconnect snapshot
    // would otherwise send a fresh frame while parked.
    this._suspended = true;
    this._listeners.clear();
    this._statusEmitter.clear();
    if (this._throttleTimer !== null) {
      clearTimeout(this._throttleTimer);
      this._throttleTimer = null;
    }
  }

  _resumeListeners(): void {
    // Reopen the outbound gate and re-advertise this client's retained
    // presence so peers restore its cursor on the resumed open without waiting
    // for the next input, the same republish `_applySnapshot` does after a
    // reconnect. No-op when nothing has been set yet.
    this._suspended = false;
    if (
      Object.keys(this._selfState).length > 0 ||
      Object.keys(this._selfExt).length > 0
    ) {
      this._republishPending = true;
      this._scheduleSend();
    }
  }

  // --- wire handling ----------------------------------------------

  private _onFrame(frame: unknown): void {
    if (this._closed || !isObject(frame)) return;
    if (frame['topic'] !== this._topic) return;
    switch (frame['type']) {
      case 'presence_snapshot':
        this._applySnapshot(frame['participants']);
        return;
      case 'presence_join':
        this._applyJoin(frame['participant']);
        return;
      case 'presence_update':
        this._applyUpdate(frame['connection_id'], frame['presence']);
        return;
      case 'presence_leave':
        this._applyLeave(frame['connection_id']);
        return;
      case 'doc_gone':
        // The server also fans `doc_gone` on `presence:doc:` (paired
        // with the subscription eviction). `leave()` stops
        // publishing immediately so a trailing presence frame crossing
        // the eviction window can't be rejected `forbidden` and surface
        // to `onError` as a misleading "subscribe(...): forbidden", and
        // drops the WS subscription so a late error finds no listeners.
        this.leave();
        return;
      default:
        // `subscribed` / `error` are handled by the shared
        // `BrassWsClient`; ignore anything unrecognised so a server
        // schema addition doesn't break an older SDK.
        return;
    }
  }

  private _applySnapshot(rawParticipants: unknown): void {
    if (!Array.isArray(rawParticipants)) return;
    this._roster.clear();
    for (const raw of rawParticipants) {
      const participant = wireToParticipant(raw);
      if (participant) this._roster.set(participant.connectionId, participant);
    }
    this._emitChange();
    // A snapshot marks a (re)subscribe settling. When this client already
    // has presence to show (a cursor set before a reconnect or a silent
    // server-side re-subscribe), republish it through the throttle so
    // peers restore it without waiting for the next user input.
    if (
      Object.keys(this._selfState).length > 0 ||
      Object.keys(this._selfExt).length > 0
    ) {
      this._republishPending = true;
      this._scheduleSend();
    }
  }

  private _applyJoin(rawParticipant: unknown): void {
    const participant = wireToParticipant(rawParticipant);
    if (!participant) return;
    this._roster.set(participant.connectionId, participant);
    this._emitChange();
  }

  private _applyUpdate(rawConnectionId: unknown, rawPresence: unknown): void {
    if (typeof rawConnectionId !== 'string') return;
    const existing = this._roster.get(rawConnectionId);
    // An update for a participant not in the roster means we missed
    // their join (e.g. a snapshot that raced the join frame). Ignore
    // it rather than synthesising a participant with no identity
    // fields; their next join / our next snapshot reconciles.
    if (!existing) return;
    const { state, ext } = splitPresencePayload(rawPresence);
    this._roster.set(rawConnectionId, {
      ...existing,
      state,
      ext,
      // `presence_update` carries no server timestamp; stamp the
      // local receive time so a consumer's idle / drop heuristic has
      // a monotonic-ish signal to age participants off.
      lastSeen: new Date().toISOString(),
    });
    this._emitChange();
  }

  private _applyLeave(rawConnectionId: unknown): void {
    if (typeof rawConnectionId !== 'string') return;
    if (this._roster.delete(rawConnectionId)) {
      this._emitChange();
    }
  }

  private _emitChange(): void {
    const roster = this.roster;
    // Copied before the walk: a listener that closes the document reaches
    // `_suspendListeners`, which clears this set, and a `Set` never visits an
    // entry removed before its turn. Iterating it live drops every listener
    // after that one.
    for (const listener of Array.from(this._listeners)) {
      try {
        listener(roster);
      } catch {
        // A throwing listener must not break the others or the read
        // loop; matches the swallow contract on `Document` subscribers.
      }
    }
  }

  // --- outbound throttle ------------------------------------------

  private _scheduleSend(): void {
    if (this._closed || this._suspended) return;
    const elapsed = Date.now() - this._lastSentAt;
    if (elapsed >= PRESENCE_PUBLISH_INTERVAL_MS) {
      this._sendNow();
      return;
    }
    if (this._throttleTimer === null) {
      // Trailing send: schedule one frame at the end of the current
      // window. Further `set(...)` calls before it fires just merge
      // into `_selfState` / `_selfExt` and ride the same trailing send.
      this._throttleTimer = setTimeout(
        () => {
          this._throttleTimer = null;
          this._sendNow();
        },
        PRESENCE_PUBLISH_INTERVAL_MS - elapsed,
      );
    }
  }

  private _sendNow(): void {
    if (this._closed || this._suspended) return;
    // Stamped even when nothing goes out, so the throttle still paces the
    // measurement rather than re-serialising on every `set(...)`.
    this._lastSentAt = Date.now();

    const withheld: PresenceLayer[] = [];
    const presence: PresenceSetInput = {};
    const state = this._publishableLayer(
      'state',
      this._selfState,
      this._sentState,
      withheld,
    );
    if (state) presence.state = state;
    const ext = this._publishableLayer(
      'ext',
      this._selfExt,
      this._sentExt,
      withheld,
    );
    if (ext) presence.ext = ext;

    this._emitStatus(withheld);

    // Every layer is either empty or oversized with nothing published behind
    // it, so the frame would carry nothing peers do not already have.
    if (presence.state === undefined && presence.ext === undefined) return;

    // A frame repeating what this connection already published costs the
    // server a row write and every peer a roster fanout, and says nothing.
    // A withheld layer makes that the steady state rather than an edge case:
    // it resolves to its last good value on every tick, so an app publishing
    // an oversized layer at its input rate would re-send that one value at up
    // to 10 Hz for as long as the layer stays over.
    const payloadKey = presencePayloadKey(presence);
    if (
      !this._republishPending &&
      payloadKey !== null &&
      payloadKey === this._sentPayloadKey
    ) {
      return;
    }
    this._republishPending = false;
    this._sentPayloadKey = payloadKey;
    this._sentState = presence.state ?? null;
    this._sentExt = presence.ext ?? null;
    this._wsClient.send({
      type: 'presence',
      topic: this._topic,
      presence,
    });
  }

  // Resolve what one layer contributes to the outbound frame: the current
  // value when it fits, otherwise the last value that did (recorded in
  // `withheld` either way). Measuring here is what keeps a presence frame
  // orders of magnitude under the size that closes the socket, which matters
  // because the socket carries the document's ops too and the reconnect
  // republishes retained presence, so one oversized frame would otherwise
  // wedge the document in a reconnect loop instead of dropping an update.
  private _publishableLayer(
    layer: PresenceLayer,
    current: Record<string, unknown>,
    lastSent: Record<string, unknown> | null,
    withheld: PresenceLayer[],
  ): Record<string, unknown> | undefined {
    if (Object.keys(current).length === 0) return undefined;
    if (presenceLayerBytes(current) <= PRESENCE_LAYER_MAX_BYTES) return current;
    withheld.push(layer);
    return lastSent ?? undefined;
  }

  private _emitStatus(withheld: PresenceLayer[]): void {
    const next: PresenceStatus =
      withheld.length === 0
        ? PRESENCE_STATUS_OK
        : { oversize: true, withheld };
    if (statusEqual(next, this.status)) return;
    if (next.oversize) {
      // The rising edge only, so a 10 Hz publisher gets one line rather than
      // ten a second. Without it an app that never wired `onStatus` has no
      // sign that its peers stopped seeing the layer.
      console.warn(
        `[Brass] presence ${next.withheld.join(' and ')} exceeds ` +
          `${PRESENCE_LAYER_MAX_BYTES} bytes and is not being published. ` +
          `Publish less, or watch presence.onStatus to react.`,
      );
    }
    this._statusEmitter.emit(next);
  }
}

// Factory for the presence controller. Called from `open-document.ts`
// when a WS client is wired onto a freshly materialised Document.
export function createPresenceController(
  wsClient: PresenceWsClient,
  docId: string,
  branchId: string,
): PresenceClient {
  return new PresenceController(wsClient, docId, branchId);
}
