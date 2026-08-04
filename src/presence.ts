// Document-scoped presence ("who is here right now"), reached as
// `doc.presence`. Owns one WS subscription on `presence:doc:<doc_id>`
// multiplexed onto the shared `BrassWsClient`: tracks the roster of
// other participants (from `presence_snapshot` + join/update/leave
// frames), publishes this client's presence via `set(...)` (shallow
// local merge, throttled outbound), and notifies `on('change')`. The
// server stores what it is sent verbatim, so the merge happens here.

// `set(...)` is debounced to at most one `presence` frame per interval
// (leading edge fires immediately, trailing send carries merges from
// the window). 100 ms = 10 Hz: low fanout cost, smooth interpolation.
export const PRESENCE_PUBLISH_INTERVAL_MS = 100;

const PRESENCE_TOPIC_PREFIX = 'presence:doc:';

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
   * Drops app-registered `change` listeners so a callback wired in the
   * parked session does not keep firing on remote presence frames after
   * the app has closed the doc, and gates the outbound publish path so a
   * parked doc stops advertising this client's cursor. Keeps the WS
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
    this._unsub = this._wsClient.subscribe(this._topic, (frame) =>
      this._onFrame(frame),
    );
  }

  get roster(): PresenceParticipant[] {
    return [...this._roster.values()];
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
        // with the SUB# eviction in `fanoutDocGone`). `leave()` stops
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
    for (const listener of this._listeners) {
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
    this._lastSentAt = Date.now();
    const presence: PresenceSetInput = {};
    if (Object.keys(this._selfState).length > 0) {
      presence.state = this._selfState;
    }
    if (Object.keys(this._selfExt).length > 0) {
      presence.ext = this._selfExt;
    }
    this._wsClient.send({
      type: 'presence',
      topic: this._topic,
      presence,
    });
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
