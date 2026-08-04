// One WS connection per SDK instance, lazily opened on the first `subscribe`.
// Multiplexes N user callbacks onto one WS-level subscription per topic: the
// subscribe frame is sent on the first callback for a topic, the unsubscribe
// frame when the last detaches.
//
// Reconnect: on `close` back off (1s..30s) and replay the "wanted-state" set
// of topics. After ~5 minutes of failure *while foregrounded* bail and fire
// `onError`, keeping the wanted-state so a later resume / `subscribe`
// recovers.
//
// Background-tab resilience: a hidden tab throttles timers but wall-clock
// (which the give-up budget measures) keeps advancing, so running the budget
// while hidden would bail on a healthy connection. The reconnect loop pauses
// while `document.hidden`; foregrounding (`visibilitychange`) or coming back
// `online` resets the backoff + budget and reconnects with a fresh token.
//
// Heartbeat: send `{ type: 'ping' }` every 60 seconds while any topic is
// subscribed. One interval serves two purposes: it resets the server's
// 10-minute idle timeout (only client-originated frames do), and it is the
// presence liveness signal (the server refreshes `last_seen` on each ping;
// the staleness threshold is 3 missed heartbeats). The server replies
// `pong`; a topic-less `{ type: 'error', reason: 'bad_message' }` is
// accepted as a no-op too, so a deploy without the `ping` handler is
// tolerated. Both are dropped.

import {
  IDLE_TOPIC,
  holdsFrames,
  step,
  type TopicEffect,
  type TopicEvent,
  type TopicState,
} from './topic-lifecycle.js';
import { SDK_CLIENT_ID } from './version.js';

interface WsClientOptions {
  wsBaseUrl: string;
  appId: string;
  getAccessToken: () => Promise<string | null>;
  // Resolves the current app assertion (the auth proxy mints it alongside
  // the access token). Sent as the `app_assertion` connect param so the
  // server can enforce Layer 2 on the socket the same way it does on HTTP;
  // absent / null just means the connection is not app-attested (the
  // server treats it as first-party, un-gated). Optional so a client
  // constructed without it (or on the first-party dashboard path) connects
  // unchanged.
  getAppAssertion?: () => Promise<string | null>;
  // The anonymous link-guest token (`?brass_link=`), or null on the
  // ordinary signed-in path. When `getAccessToken` returns null but this
  // returns a token, the socket connects with `brass_link=<token>` instead
  // of `token=<accessToken>`, and the server admits a read-only,
  // single-doc-scoped guest connection. Optional so a normal client is
  // unchanged.
  getGuestLinkToken?: () => string | null;
  // WebSocket constructor injection for tests; defaults to
  // `globalThis.WebSocket`.
  webSocketImpl?: typeof WebSocket;
  // Surfaces transport errors (auth fail, reconnect bail, subscribe forbidden)
  // to the client's onError channel.
  fireError: (error: Error) => void;
}

export type WsTopicCallback = (frame: unknown) => void;

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000];
const RECONNECT_GIVE_UP_MS = 5 * 60 * 1000;
const HEARTBEAT_INTERVAL_MS = 60_000;
// Cap on the frames held for one topic's unacked subscribe, matching the
// `outboundQueue` bound. Both hold the same kind of mid-reconnect frames
// (a disconnect rolls every wanted topic back to `subscribing`, so ops sent
// during the reconnect window are HELD here rather than in `outboundQueue`),
// so both need the same memory ceiling or a doc edited through a long outage
// grows one queue without bound. Generous for a single user's in-flight ops.
const MAX_QUEUED_FRAMES = 1024;

type Listeners = Set<WsTopicCallback>;

export class BrassWsClient {
  private ws: WebSocket | null = null;
  private connecting = false;
  // Monotonic connect-attempt token. `close()` and each new attempt bump it,
  // so a continuation parked on the token / assertion awaits in
  // `ensureConnected` can tell its attempt was superseded and bail instead
  // of adopting a socket nobody wants (a zombie the heartbeat would keep
  // alive past the gateway idle timeout). Mechanical: any await added to
  // the connect path is covered by re-checking the epoch after it.
  private connectEpoch = 0;
  // Per-topic lifecycle state, driven exclusively through the pure
  // `step` transition table in `topic-lifecycle.ts`: handlers translate
  // frames / user calls into events via `dispatch` and execute the
  // returned effects. Wanted topics (the ones a reconnect replays) are
  // the entries in a non-`tornDown` phase; the listener map below is the
  // callback data those decisions act on.
  private topics = new Map<string, TopicState>();
  private listeners = new Map<string, Listeners>();
  // Outbound frames queued while the socket is not OPEN. Drained on `open`
  // (after subscribe replay) so an optimistic `mutate()` survives a reconnect
  // window.
  private outboundQueue: unknown[] = [];
  // Per-topic queues of frames held while `holdsFrames` says the topic's
  // subscribe is unacked: a topic-scoped frame (`presence`, `op`) sent
  // before the `subscribed` reply races the SUB# row write and the
  // server's conditional update fails as a spurious `forbidden`. The
  // machine's `flush_held` / `drop_held` effects drain or discard them.
  // Bounded per topic (`MAX_QUEUED_FRAMES`, drop-oldest) so a doc edited
  // through a long outage can't grow it without limit.
  private pendingTopicSends = new Map<string, unknown[]>();
  // Warn-once latch for held-queue overflow drops, reset when a topic's held
  // frames flush on the `subscribed` ack, so each unacked window reports once.
  private heldOverflowReported = false;
  private reconnectAttempt = 0;
  private reconnectStartedAt: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Warn-once latch for outbound-queue overflow drops; reset when the queue
  // drains on a successful (re)connect, so each disconnect reports at most
  // once.
  private outboundOverflowReported = false;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;
  // Page-lifecycle listeners, installed lazily on first connect and removed on
  // user close. Guarded for non-DOM environments (Node, SSR).
  private visibilityListener: (() => void) | null = null;
  private onlineListener: (() => void) | null = null;

  constructor(private readonly opts: WsClientOptions) {}

  // Returns an unsubscribe that detaches THIS callback only; the WS-level
  // subscription stays open while other callbacks remain, and the unsubscribe
  // frame is sent only when the last detaches.
  subscribe(topic: string, callback: WsTopicCallback): () => void {
    let set = this.listeners.get(topic);
    const firstForTopic = !set;
    if (!set) {
      set = new Set();
      this.listeners.set(topic, set);
    }
    set.add(callback);

    if (firstForTopic) {
      this.dispatch(topic, { type: 'user_subscribe' });
      void this.ensureConnected();
    } else if (!this.ws && !this.connecting && !this.reconnectTimer) {
      // The wanted-state held this topic but there's no socket and no
      // reconnect in flight (a prior give-up or a drop while hidden): a fresh
      // subscribe is the retry signal. (A pending reconnect timer is left
      // alone so its backoff isn't reset.)
      this.resume();
    }

    return () => {
      const current = this.listeners.get(topic);
      if (!current) return;
      current.delete(callback);
      if (current.size > 0) return;
      this.listeners.delete(topic);
      this.dispatch(topic, { type: 'user_unsubscribe' });
      // Drop the connection once no topic is wanted, so no idle socket lingers.
      if (this.listeners.size === 0) {
        this.close();
      }
    };
  }

  // Feed one event through the topic's machine, commit the new state, then
  // execute the effects. `idle` results are pruned; `tornDown` entries are
  // kept so a same-connection re-subscribe inherits the spent retry, and
  // the next socket transition prunes them.
  private dispatch(topic: string, event: TopicEvent): void {
    const prior = this.topics.get(topic) ?? IDLE_TOPIC;
    const { state, effects } = step(prior, event);
    if (state.phase === 'idle') {
      this.topics.delete(topic);
    } else if (event.type === 'user_subscribe') {
      // Re-insert so the map's order (the reconnect replay order) tracks
      // subscription order even for a topic re-subscribed after teardown.
      this.topics.delete(topic);
      this.topics.set(topic, state);
    } else {
      this.topics.set(topic, state);
    }
    for (const effect of effects) {
      this.runEffect(topic, effect);
    }
  }

  private runEffect(topic: string, effect: TopicEffect): void {
    switch (effect.kind) {
      case 'send_subscribe':
        // Dropped when the socket is not open; `socket_open` re-derives a
        // `send_subscribe` for every wanted topic, so nothing is lost.
        this.sendIfOpen({ type: 'subscribe', topic });
        return;
      case 'send_unsubscribe':
        this.sendIfOpen({ type: 'unsubscribe', topic });
        return;
      case 'flush_held': {
        const queued = this.pendingTopicSends.get(topic);
        if (queued) {
          this.pendingTopicSends.delete(topic);
          for (const f of queued) this.sendFrame(f);
        }
        // The unacked window closed; re-arm the overflow warning for the next.
        this.heldOverflowReported = false;
        return;
      }
      case 'drop_held':
        this.pendingTopicSends.delete(topic);
        return;
      case 'drop_listeners':
        this.listeners.delete(topic);
        return;
      case 'fire_error':
        this.opts.fireError(
          new Error(`Brass WebSocket subscribe(${topic}): ${effect.reason}`),
        );
        return;
    }
  }

  // Send an arbitrary frame. Queued when the socket is not open and drained on
  // the next `open` (covering a mutate during the subscribe handshake gap and
  // ops that must survive a mid-session reconnect). Failures (overflow, closed
  // transport) are silently dropped.
  send(frame: unknown): void {
    // Topic-scoped frames sent before the `subscribed` ack race the SUB# row
    // write and surface as spurious `forbidden`, so hold them until the ack
    // (see `pendingTopicSends`). The machine's `holdsFrames` covers every
    // unacked wanted state (fresh subscribe, reconnect replay, retry).
    const topic = topicOfFrame(frame);
    const topicState = topic !== undefined ? this.topics.get(topic) : undefined;

    if (topic !== undefined && topicState && holdsFrames(topicState)) {
      let queue = this.pendingTopicSends.get(topic);
      if (!queue) {
        queue = [];
        this.pendingTopicSends.set(topic, queue);
      }
      // Bounded like `outboundQueue`: drop the oldest held frame on
      // overflow. Safe to drop here because an op is re-asserted by the
      // per-doc resend tracker (keyed independently on `client_op_id`), and
      // a dropped presence frame is superseded by the next `set()`.
      if (queue.length >= MAX_QUEUED_FRAMES) {
        queue.shift();
        if (!this.heldOverflowReported) {
          this.heldOverflowReported = true;
          this.opts.fireError(
            new Error(
              'Brass WebSocket: held-frame queue overflowed while a subscribe was unacked; the oldest queued frames were dropped',
            ),
          );
        }
      }
      queue.push(frame);
      // Ensure a connection is in flight; the machine re-emits the
      // subscribe on `socket_open`.
      void this.ensureConnected();
      return;
    }

    if (this.ws && this.ws.readyState === this.ws.OPEN) {
      this.sendFrame(frame);
      return;
    }
    // Bounded so a misbehaving caller can't leak memory; 1024 is generous for
    // a single user's mid-session ops during a reconnect (each typically <1KB).
    if (this.outboundQueue.length >= 1024) {
      this.outboundQueue.shift();
      // A dropped frame can be an op the caller believes is saved-pending;
      // surface it, once per overflow episode so a runaway producer can't
      // flood the error channel.
      if (!this.outboundOverflowReported) {
        this.outboundOverflowReported = true;
        this.opts.fireError(
          new Error(
            'Brass WebSocket: outbound queue overflowed while disconnected; the oldest queued frames were dropped and will not reach the server',
          ),
        );
      }
    }
    this.outboundQueue.push(frame);
    // Kick the connect path if no socket is open yet (a caller that `send`s
    // without ever subscribing), or the queue would never drain.
    if (!this.ws && !this.connecting && !this.closedByUser) {
      void this.ensureConnected();
    }
  }

  close(): void {
    this.closedByUser = true;
    // Supersede any in-flight connect attempt, and clear `connecting` so a
    // subscribe / send that lands after this close starts its own fresh
    // attempt through the normal entry path (fresh token, lifecycle
    // listeners re-armed) instead of finding the entry guard held by a
    // continuation that is about to bail.
    this.connectEpoch++;
    this.connecting = false;
    this.removeLifecycleListeners();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    // `socket_closed` per topic: drops held frames and rolls wanted topics
    // back to `subscribing` so a later resume replays them.
    for (const topic of this.topics.keys()) {
      this.dispatch(topic, { type: 'socket_closed' });
    }
    this.outboundQueue = [];
    if (ws && ws.readyState !== ws.CLOSED && ws.readyState !== ws.CLOSING) {
      try {
        ws.close();
      } catch {
        // Closing an already-closing socket is fine.
      }
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === this.ws.OPEN) return;
    if (this.connecting) return;
    this.ensureLifecycleListeners();
    this.connecting = true;
    this.closedByUser = false;
    const epoch = ++this.connectEpoch;
    try {
      const token = await this.opts.getAccessToken();
      if (epoch !== this.connectEpoch) return;
      // Anonymous link guest: no access token, but a link token authorises a
      // read-only connection.
      const guestToken = token ? null : this.opts.getGuestLinkToken?.() ?? null;
      if (!token && !guestToken) {
        this.connecting = false;
        this.opts.fireError(
          new Error('Brass WebSocket subscribe: not signed in'),
        );
        return;
      }
      const Ctor = this.opts.webSocketImpl ?? globalThis.WebSocket;
      if (!Ctor) {
        this.connecting = false;
        this.opts.fireError(
          new Error('Brass WebSocket subscribe: WebSocket is not available'),
        );
        return;
      }
      const assertion =
        token && this.opts.getAppAssertion
          ? await this.opts.getAppAssertion()
          : null;
      if (epoch !== this.connectEpoch) return;
      const url = token
        ? this.buildUrl(token, assertion)
        : this.buildGuestUrl(guestToken as string);
      // The OPEN guard at the top returns only for a socket that is OPEN; a
      // CONNECTING/CLOSING one falls through to here, so a prior socket can
      // still be around. Adopt the new socket as `this.ws` FIRST, then close
      // the old one: its `close` then fails the identity guard below and is
      // ignored, rather than nulling out the live socket.
      const prev = this.ws;
      const ws = new Ctor(url);
      this.ws = ws;
      // Guard every lifecycle handler on socket identity. A superseded
      // socket's delayed `close` (common on a throttled hidden tab) would
      // otherwise run `onClose`, null out the live `this.ws`, roll every
      // topic back to `subscribing`, and schedule a spurious reconnect.
      ws.addEventListener('open', () => {
        if (this.ws === ws) this.onOpen();
      });
      ws.addEventListener('message', (ev: MessageEvent) => {
        if (this.ws === ws) this.onMessage(ev);
      });
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.onClose();
      });
      ws.addEventListener('error', () => {
        // The `close` handler runs after `error` and drives reconnect;
        // swallowing keeps a transient network error from bubbling.
      });
      if (prev) {
        try {
          prev.close();
        } catch {
          // Closing an already-closing socket is fine.
        }
      }
    } catch (err) {
      // A superseded attempt's failure is not this client's failure: the
      // `connecting` flag now belongs to the newer attempt, so leave it.
      if (epoch !== this.connectEpoch) return;
      this.connecting = false;
      this.opts.fireError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private buildUrl(token: string, assertion: string | null): string {
    const base = this.opts.wsBaseUrl.replace(/\/$/, '');
    const sep = base.includes('?') ? '&' : '?';
    const assertionParam = assertion
      ? `&app_assertion=${encodeURIComponent(assertion)}`
      : '';
    // `client` feeds the ws.connect audit so the deployed SDK version
    // distribution is measurable per live connection.
    return `${base}${sep}app_id=${encodeURIComponent(
      this.opts.appId,
    )}&token=${encodeURIComponent(token)}${assertionParam}&client=${encodeURIComponent(SDK_CLIENT_ID)}`;
  }

  // Anonymous link-guest connect URL: the link token authorises the socket
  // (no access token, no app assertion). The server resolves it to a
  // read-only, single-doc-scoped connection.
  private buildGuestUrl(guestToken: string): string {
    const base = this.opts.wsBaseUrl.replace(/\/$/, '');
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}app_id=${encodeURIComponent(
      this.opts.appId,
    )}&brass_link=${encodeURIComponent(guestToken)}`;
  }

  private onOpen(): void {
    this.connecting = false;
    this.reconnectAttempt = 0;
    this.reconnectStartedAt = null;
    // `socket_open` per topic: re-subscribes every wanted topic (in
    // subscription order) with a fresh retry grant, and prunes `tornDown`
    // leftovers. Runs before the outbound drain so the server sees the
    // subscribes first; otherwise an op right after a reconnect races its
    // subscribe and gets `bad_message` (not subscribed yet).
    for (const topic of this.topics.keys()) {
      this.dispatch(topic, { type: 'socket_open' });
    }
    this.flushOutbound();
    this.startHeartbeat();
  }

  private flushOutbound(): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    const drained = this.outboundQueue;
    this.outboundQueue = [];
    this.outboundOverflowReported = false;
    for (const frame of drained) {
      this.sendFrame(frame);
    }
  }

  private onMessage(ev: MessageEvent): void {
    let frame: unknown;
    try {
      frame = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
    } catch {
      // Drop garbage; the server protocol is strict JSON.
      return;
    }
    if (!isObject(frame)) return;
    const type = frame.type;
    if (typeof type !== 'string') return;

    if (type === 'subscribed' && typeof frame.topic === 'string') {
      // `flush_held` drains the frames held back for the unacked subscribe.
      this.dispatch(frame.topic, { type: 'subscribed_ack' });
      return;
    }
    if (type === 'unsubscribed') {
      // No callbacks fire; the user-side unsubscribe already returned.
      return;
    }
    if (type === 'pong') {
      // Heartbeat reply; drop silently (the round-trip already reset API
      // Gateway's idle-timeout).
      return;
    }
    if (type === 'error') {
      const topic = typeof frame.topic === 'string' ? frame.topic : undefined;
      const reason = typeof frame.reason === 'string' ? frame.reason : 'error';
      // A deploy without the `ping` handler replies to our ping with a
      // topic-less `bad_message` instead of `pong`; treat it as a heartbeat
      // ack (see the header).
      if (reason === 'bad_message' && !topic) return;
      if (topic) {
        // The machine decides: silent retry, swallow, or teardown +
        // `fire_error`. A topic with no live state (already unsubscribed
        // or torn down our side) swallows: the canonical case is a
        // presence-update racing a `doc_gone` eviction, whose late
        // `forbidden` reply would otherwise surface as a misleading
        // "subscribe(...): forbidden" with no subscribe in flight to fail.
        this.dispatch(topic, { type: 'error', reason });
        return;
      }
      this.opts.fireError(
        new Error(`Brass WebSocket subscribe: ${reason}`),
      );
      return;
    }
    // Topic-scoped server frames: fan out to every callback for the topic.
    if (typeof frame.topic === 'string') {
      const set = this.listeners.get(frame.topic);
      if (!set) return;
      for (const cb of set) {
        try {
          cb(frame);
        } catch {
          // A bad listener must not break the others or kill the read loop.
        }
      }
    }
  }

  private onClose(): void {
    this.stopHeartbeat();
    this.ws = null;
    // Held frames are tied to the connection's unacked subscribes;
    // `socket_closed` drops them and preserves wantedness for the replay.
    for (const topic of this.topics.keys()) {
      this.dispatch(topic, { type: 'socket_closed' });
    }
    this.connecting = false;
    if (this.closedByUser) return;
    if (this.listeners.size === 0) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    // Don't run the loop while hidden: throttled timers but advancing
    // wall-clock would burn the give-up budget without real attempts and bail
    // on a healthy connection. `resume()` restarts with a fresh budget on
    // foreground / network recovery.
    if (this.isHidden()) return;
    if (this.reconnectStartedAt === null) {
      this.reconnectStartedAt = Date.now();
    }
    if (Date.now() - this.reconnectStartedAt >= RECONNECT_GIVE_UP_MS) {
      this.opts.fireError(
        new Error(
          'Brass WebSocket subscribe: reconnect gave up after 5 minutes',
        ),
      );
      // Keep the wanted-state: a resume / fresh `subscribe` recovers by
      // replaying it. The budget resets so resume starts clean; clearing
      // listeners here would make the bail permanent (the background-tab bug
      // this guards against).
      this.reconnectAttempt = 0;
      this.reconnectStartedAt = null;
      return;
    }
    const idx = Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1);
    const delay = RECONNECT_DELAYS_MS[idx]!;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected();
    }, delay);
  }

  // Foreground return / network recovery: reset the backoff + give-up budget
  // and reconnect promptly with a fresh token instead of waiting out a long
  // delay or staying dead after a bail. No-op when nothing is wanted, the user
  // closed us, or a socket is already open.
  private resume(): void {
    if (this.closedByUser) return;
    if (this.listeners.size === 0) return;
    if (this.ws && this.ws.readyState === this.ws.OPEN) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.reconnectStartedAt = null;
    void this.ensureConnected();
  }

  private isHidden(): boolean {
    const doc = (globalThis as { document?: { hidden?: boolean } }).document;
    return doc?.hidden === true;
  }

  private ensureLifecycleListeners(): void {
    if (this.visibilityListener || this.onlineListener) return;
    const doc = (
      globalThis as {
        document?: {
          addEventListener?: (type: string, listener: () => void) => void;
          hidden?: boolean;
        };
      }
    ).document;
    if (doc && typeof doc.addEventListener === 'function') {
      const listener = (): void => {
        if (doc.hidden !== true) this.resume();
      };
      this.visibilityListener = listener;
      doc.addEventListener('visibilitychange', listener);
    }
    if (typeof globalThis.addEventListener === 'function') {
      const listener = (): void => this.resume();
      this.onlineListener = listener;
      globalThis.addEventListener('online', listener);
    }
  }

  private removeLifecycleListeners(): void {
    const doc = (
      globalThis as {
        document?: {
          removeEventListener?: (type: string, listener: () => void) => void;
        };
      }
    ).document;
    if (
      this.visibilityListener &&
      doc &&
      typeof doc.removeEventListener === 'function'
    ) {
      doc.removeEventListener('visibilitychange', this.visibilityListener);
    }
    this.visibilityListener = null;
    if (
      this.onlineListener &&
      typeof globalThis.removeEventListener === 'function'
    ) {
      globalThis.removeEventListener('online', this.onlineListener);
    }
    this.onlineListener = null;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendIfOpen({ type: 'ping' });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private sendIfOpen(frame: unknown): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    this.sendFrame(frame);
  }

  private sendFrame(frame: unknown): void {
    if (!this.ws) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      // A send failure means the connection is half-dead; `close` fires
      // shortly and drives reconnect.
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

// The frame's topic, if any. `send()` uses it to decide whether the frame is
// subject to the subscribe-pending hold (see `pendingTopicSends`). Returns
// `undefined` for transport frames (`subscribe` / `unsubscribe` / `ping` /
// `pong`), which the hold must NOT apply to (the subscribe is what it waits
// for).
function topicOfFrame(frame: unknown): string | undefined {
  if (!isObject(frame)) return undefined;
  const type = frame['type'];
  if (
    type === 'subscribe' ||
    type === 'unsubscribe' ||
    type === 'ping' ||
    type === 'pong'
  ) {
    return undefined;
  }
  const topic = frame['topic'];
  return typeof topic === 'string' ? topic : undefined;
}
