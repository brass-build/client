// One WS connection per SDK instance, lazily opened on the first `subscribe`.
// Multiplexes N user callbacks onto one WS-level subscription per topic: the
// subscribe frame is sent on the first callback for a topic, the unsubscribe
// frame when the last detaches.
//
// Reconnect: on `close` back off (1s..30s) and replay the "wanted-state" set
// of topics. After `RECONNECT_MAX_ATTEMPTS` consecutive failures it fires
// `onError` once and drops to a slow retry, so a wrong verdict costs a
// reader a delay rather than their connection. One counter both bounds and
// paces the loop, and it counts attempts rather than time (see the
// constant), so a hidden tab goes on reconnecting under the same bound as a
// visible one. What clears it is a socket the server answered, or a reader
// coming back via `visibilitychange` / `online`.
//
// Heartbeat: send `{ type: 'ping' }` every 60 seconds while any topic is
// subscribed. One interval serves two purposes: it resets the server's
// 10-minute idle timeout (only client-originated frames do), and it is the
// presence liveness signal (the server refreshes `last_seen` on each ping;
// the staleness threshold is 3 missed heartbeats). The server replies
// `pong`. The same interval notices a socket that has stopped carrying
// anything at all (`SOCKET_SILENCE_LIMIT_MS`), since on an idle connection
// it is the only thing running; such a socket is retired here so the
// reconnect loop can replace it, because a dead path does not reliably close
// itself. A topic-less `{ type: 'error', reason: 'bad_message' }` is the
// server's catch-all rejection, so it is swallowed rather than surfaced (a
// deploy without the `ping` handler answers a heartbeat with it) but never
// counted as the connection working. Both are dropped.

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
// Failed attempts before the loop reports and slows, counted rather than
// timed because the loop's pacing is not ours: a hidden page's timers are
// throttled to roughly one firing a minute while wall-clock runs on at full
// speed. A budget measured in time therefore either bails on a healthy
// connection the moment a reader tabs away, or excludes hidden time and
// leaves a hidden page unbounded. A count measures what the loop actually
// did, so neither the page's visibility nor the machine's clock enters into
// it.
//
// Against the delays above this spans 301s, so a foregrounded page reaches it
// in about five minutes, which is what a genuinely broken connection
// (offline, signed out, endpoint down) looks like. A throttled one takes as
// long as its own timers take, roughly a quarter hour. Retuning the delays
// re-prices this, which `ws-client.test.ts` pins.
const RECONNECT_MAX_ATTEMPTS = 15;
// What the loop backs off to once it has passed that threshold. It keeps
// retrying at this pace for as long as topics are wanted, so a client is
// never left with nothing running: a misjudged connection recovers on its
// own within one interval instead of waiting for a reader to come back.
// Against an endpoint that is genuinely down this is the whole standing
// cost, which is why it is minutes rather than the 30s ceiling above.
const RECONNECT_IDLE_DELAY_MS = 5 * 60_000;
const HEARTBEAT_INTERVAL_MS = 60_000;
// When a socket sends its FIRST ping. The steady cadence answers API
// Gateway's 10-minute idle timeout; this one exists so the reconnect loop
// can tell a working connection from a flapping one.
//
// It is a MINIMUM LIFETIME, not a latency tweak, and that is the part to
// keep: a `pong` is the only thing a quiet subscription can draw (a topic
// with no activity produces its ack and then nothing), so this delay is how
// long a socket must survive before it can clear the count. Send the first
// ping at open instead and a backend that accepts, answers and drops in
// 200ms credits itself on every socket, so the loop never ends and retries
// at the 1s floor for as long as the page is open.
//
// A background page clamps its timers to about a minute, so a hidden reader
// on a quiet topic falls back to the steady cadence. That page is bounded
// rather than wrong: it parks, and returning to it clears the count. A
// hidden page doing WORK is unaffected, because its ops draw `op_ack`.
const HEARTBEAT_FIRST_MS = 10_000;
// How long a socket may carry nothing at all before this client treats it as
// gone. A dead path does not always close: when a phone changes network
// neither end sends a FIN, so a socket that will never carry another byte
// still reads as OPEN, and nothing downstream notices, because the reconnect
// loop is driven by `close` and an op's resend goes out on the same socket.
// ANY inbound frame answers this, not just the `pong` the reconnect count
// credits: the question is whether the path still carries bytes. Two missed
// replies plus slack, so one dropped `pong` is not enough.
const SOCKET_SILENCE_LIMIT_MS = 150_000;
// Spread added to that limit, because the condition is SHARED: the server
// answers a `ping` after an awaited presence refresh and reap sweep, so its
// replies slow under exactly the load that makes sockets fragile, and every
// client goes silent at once. An unjittered threshold turns one degradation
// into a synchronized wave of reconnects landing on a service already
// shedding.
//
// Drawn PER SOCKET, not once per client. Clients that retire together
// reconnect together, so their next silence window is tighter than the last;
// a fixed per-client offset keeps its phase inside that convergence, where a
// fresh draw on every open scatters the schedule the wave just aligned. Two
// heartbeat intervals wide, since the check rides the 60s tick and a spread
// under one tick is quantized away.
const SOCKET_SILENCE_JITTER_MS = 120_000;
// Cap on the frames held for one topic's unacked subscribe, matching the
// `outboundQueue` bound. A disconnect rolls every wanted topic back to
// `subscribing`, so both queues hold the same kind of mid-reconnect frame
// and both need the same memory ceiling, or a topic written to through a
// long outage grows one of them without bound.
const MAX_QUEUED_FRAMES = 1024;

// Per-callback subscription metadata. `expectGap` is what makes the
// `onSubscribed` resubscribe flag honest: it arms once the listener has a
// live (`established`) subscription behind it, so any LATER ack means the
// socket dropped in between and frames may have been missed.
interface ListenerMeta {
  onSubscribed?: (info: { resubscribed: boolean }) => void;
  onEnded?: (info: { reason: string }) => void;
  expectGap: boolean;
}

type Listeners = Map<WsTopicCallback, ListenerMeta>;

export interface SubscribeOptions {
  // Fired on every `subscribed` ack for the topic while this callback is
  // attached. `resubscribed: false` is the initial subscribe;
  // `resubscribed: true` means the subscription was re-established after a
  // drop, so frames fanned out in the gap were lost and the subscriber
  // should reconcile by refetching (org-topic events carry no catch-up;
  // only the `doc:` topics replay via `doc_init`).
  onSubscribed?: (info: { resubscribed: boolean }) => void;
  // Fired once when the server ends the subscription under a caller that
  // still wants it: it refused the subscribe (a revoked grant), or evicted
  // it again after the one silent re-subscribe a connection grants. The
  // client detaches this callback as it fires, so the topic is over for
  // this subscriber whatever the socket does next.
  //
  // A subscriber holding work for the topic reads this as the end of the
  // road for that work: a document's unacked ops can no longer be acked, so
  // it fails them here rather than re-sending them into a subscription the
  // server has refused, which pins `savingCount` above zero and tells the
  // app nothing.
  onEnded?: (info: { reason: string }) => void;
  // This subscriber re-asserts its own identified frames (the ones carrying
  // a `client_op_id`) whenever the subscription is established, so the
  // client DROPS such a frame it cannot put on the wire right now instead
  // of buffering it.
  //
  // Buffering it as well is what writes it twice: the buffer flushes on the
  // `subscribed` ack and the subscriber re-asserts on the same signal, and
  // the server allocates a fresh seq per send rather than deduplicating on
  // the id. Worse across an outage, where the topic sits unacked for its
  // whole length and each of the subscriber's retries appends another copy
  // to the buffer, all of which flush at once on the ack.
  //
  // Only for a subscriber that really does re-assert: a frame dropped here
  // reaches the server only if its owner sends it again.
  ownsFrameRetry?: boolean;
}

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
  // (after subscribe replay) so a frame nobody re-asserts survives a
  // reconnect window.
  private outboundQueue: unknown[] = [];
  // Per-topic queues of frames held while `holdsFrames` says the topic's
  // subscribe is unacked: a topic-scoped frame (`presence`, `op`) sent
  // before the `subscribed` reply races the subscription record write and the
  // server's conditional update fails as a spurious `forbidden`. The
  // machine's `flush_held` / `drop_held` effects drain or discard them.
  // Bounded per topic (`MAX_QUEUED_FRAMES`, drop-oldest) so a topic written
  // to through a long outage can't grow it without limit.
  private pendingTopicSends = new Map<string, unknown[]>();
  // Topics whose subscriber re-asserts its own identified frames (see
  // `SubscribeOptions.ownsFrameRetry`). Held per topic rather than per
  // listener because the decision is about the frame's fate on the wire,
  // which every listener on the topic shares.
  private ownFrameRetryTopics = new Set<string>();
  // Warn-once latch for held-queue overflow drops, reset when a topic's held
  // frames flush on the `subscribed` ack, so each unacked window reports once.
  private heldOverflowReported = false;
  // Consecutive failures, which paces the loop AND decides whether this
  // connection is working at all. One number answers both, because the two
  // questions have the same evidence behind them: a socket that opened is
  // not progress, so pacing on opening pins the delay at the 1s floor
  // against a backend that accepts and hangs up, at ~86,000 sockets a day
  // per tab for zero connected time. Only a frame the server sent in answer
  // to this client clears it.
  private failedAttempts = 0;
  // Latches the failing report, so one incident is reported once however
  // long it lasts.
  private reportedFailing = false;
  // Credited frames on the CURRENT socket, reset on open. Two of them is
  // what re-arms the latch, and the pair is the point: a single answer is
  // survivable by a socket that dies straight after, where a second means
  // this socket lived past `HEARTBEAT_FIRST_MS` into the steady cadence and
  // is genuinely serving the reader. Without a recovery-observed clear the
  // latch never lifts on its own, since `resume` returns early while a
  // socket is open and a Node client has no `visibilitychange` to fire it,
  // so a second outage after a recovery would go unreported for the life of
  // the process.
  private creditsThisSocket = 0;
  // When this socket last carried anything inbound, set on open so a socket
  // that never speaks is measured from the moment it opened. Zero while no
  // socket is up, which stops a silence check firing against a connection
  // that does not exist.
  private lastInboundAt = 0;
  // This socket's silence threshold, redrawn on every open. Held as state so
  // one socket cannot move its own deadline every time the check looks at it.
  private silenceLimitMs = SOCKET_SILENCE_LIMIT_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Sockets this client has opened. Every topic and every open document
  // rides this one socket, so the count is a fact about the client rather
  // than about any one of them. Reported in a client's own sync-health
  // report, where a high count beside unacked work is what distinguishes a
  // connection that keeps dropping mid-write from one that is merely slow.
  private socketsOpened = 0;
  // Warn-once latch for outbound-queue overflow drops; reset when the queue
  // drains on a successful (re)connect, so each disconnect reports at most
  // once.
  private outboundOverflowReported = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  // Page-lifecycle listeners, installed lazily on first connect and removed on
  // user close. Guarded for non-DOM environments (Node, SSR).
  private visibilityListener: (() => void) | null = null;
  private onlineListener: (() => void) | null = null;

  constructor(private readonly opts: WsClientOptions) {}

  // Returns an unsubscribe that detaches THIS callback only; the WS-level
  // subscription stays open while other callbacks remain, and the unsubscribe
  // frame is sent only when the last detaches.
  subscribe(
    topic: string,
    callback: WsTopicCallback,
    options: SubscribeOptions = {},
  ): () => void {
    let set = this.listeners.get(topic);
    const firstForTopic = !set;
    if (!set) {
      set = new Map();
      this.listeners.set(topic, set);
    }
    set.set(callback, {
      ...(options.onSubscribed ? { onSubscribed: options.onSubscribed } : {}),
      ...(options.onEnded ? { onEnded: options.onEnded } : {}),
      // Attaching to an already-established subscription: the next ack this
      // listener sees is a reconnect, and the gap since attach is real.
      expectGap: this.topics.get(topic)?.phase === 'established',
    });
    if (options.ownsFrameRetry) this.ownFrameRetryTopics.add(topic);

    if (firstForTopic) {
      this.dispatch(topic, { type: 'user_subscribe' });
      void this.ensureConnected();
    } else if (!this.ws && !this.connecting && !this.reconnectTimer) {
      // The wanted-state held this topic but there's no socket and no
      // reconnect in flight (a prior give-up or a drop while hidden): a fresh
      // subscribe is the retry signal. (A pending reconnect timer is left
      // alone so its backoff isn't reset.)
      //
      // A closed client goes through the front door instead, because
      // `resume()` refuses one and this branch would otherwise be the single
      // retry signal with no way out: subscribing a topic the wanted-state
      // still holds would leave the client dead for good, where subscribing
      // any other topic recovers it.
      if (this.closedByUser) void this.ensureConnected();
      else this.resume();
    }

    return () => {
      const current = this.listeners.get(topic);
      if (!current) return;
      current.delete(callback);
      if (current.size > 0) return;
      this.listeners.delete(topic);
      this.ownFrameRetryTopics.delete(topic);
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
    // Teardown detaches the topic's callbacks, so the subscribers owed an
    // end notice are captured before the effects drop them and told once the
    // topic is released: a subscriber that closes itself from `onEnded` then
    // finds nothing left to unsubscribe. `fire_error` carries the same reason
    // to the session-wide channel; this notice is what reaches the one
    // subscriber that has to give up the work it holds for the topic.
    const ending =
      event.type === 'error' && effects.some((e) => e.kind === 'drop_listeners')
        ? {
            reason: event.reason,
            metas: [...(this.listeners.get(topic)?.values() ?? [])],
          }
        : null;
    for (const effect of effects) {
      this.runEffect(topic, effect);
    }
    if (ending) {
      for (const meta of ending.metas) {
        try {
          meta.onEnded?.({ reason: ending.reason });
        } catch {
          // A bad listener must not break the others or kill the read loop.
        }
      }
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
      case 'deliver_error':
        // Rebuilt rather than forwarded: a topic error frame is exactly
        // these three fields.
        this.fanOut(topic, { type: 'error', topic, reason: effect.reason });
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
    // Topic-scoped frames sent before the `subscribed` ack race the subscription record
    // write and surface as spurious `forbidden`, so hold them until the ack
    // (see `pendingTopicSends`). The machine's `holdsFrames` covers every
    // unacked wanted state (fresh subscribe, reconnect replay, retry).
    const topic = topicOfFrame(frame);
    const topicState = topic !== undefined ? this.topics.get(topic) : undefined;
    // Buffering this frame would duplicate it, because its owner sends it
    // again on the next `subscribed` ack (see `ownsFrameRetry`).
    const ownerResends =
      topic !== undefined &&
      this.ownFrameRetryTopics.has(topic) &&
      isIdentifiedFrame(frame);

    if (topic !== undefined && topicState && holdsFrames(topicState)) {
      if (ownerResends) return;
      let queue = this.pendingTopicSends.get(topic);
      if (!queue) {
        queue = [];
        this.pendingTopicSends.set(topic, queue);
      }
      // Bounded like `outboundQueue`: drop the oldest held frame on
      // overflow. What reaches this queue is a frame nobody re-asserts (the
      // ones that are re-asserted took the `ownerResends` exit above), so
      // the drop is reported.
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
    if (ownerResends) return;
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
    // `failedAttempts` deliberately survives. An app reaches `close()`
    // routinely rather than only on teardown, so clearing it here lets a
    // client one step from the bound start over on every cycle and the loop
    // never ends. A frame from the server is what clears it.
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
    // The reconnect bound is deliberately not consulted here. A caller's own
    // connect always attempts, so a client parked on the bound still reaches
    // a network that has recovered, and the frame that comes back clears the
    // count. What the bound stops is the unattended retry loop.
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
      // The superseded socket's `close` is dropped by the identity guard, so
      // `onClose` never runs for it and its heartbeat would outlive it.
      if (prev) this.stopHeartbeat();
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
      // Reported until the loop has said the connection is failing, then
      // left to that one report. The throw here repeats on every attempt of
      // an outage, so relaying each one turns a single incident into an
      // error per attempt for as long as it lasts.
      if (!this.reportedFailing) {
        this.opts.fireError(err instanceof Error ? err : new Error(String(err)));
      }
      // The token and the assertion reject on a momentary outage (a shed
      // `/refresh`), which is the same transient the reconnect loop backs
      // off on when a live socket drops. The throw happens before any
      // socket exists, so no `close` event drives that loop and the retry
      // is scheduled from here, on the same backoff and the same give-up
      // budget. A signed-out session resolves null instead and takes the
      // branch above, which stays terminal.
      if (this.closedByUser) return;
      if (this.listeners.size === 0) return;
      this.scheduleReconnect();
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
    this.socketsOpened += 1;
    this.creditsThisSocket = 0;
    this.lastInboundAt = Date.now();
    this.silenceLimitMs =
      SOCKET_SILENCE_LIMIT_MS + Math.random() * SOCKET_SILENCE_JITTER_MS;
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

  // Re-`send` each drained frame rather than writing it straight to the
  // socket: the topic it belongs to has just been re-subscribed and its ack
  // is still outstanding, so a frame written now races the server's
  // subscription record write and comes back `not_subscribed`, which tears
  // the topic down
  // and leaves the document deaf on a live connection. `send` applies the
  // hold (or the drop) the topic's current state calls for. The queue is
  // swapped out first, so a frame `send` re-queues lands in the new array
  // instead of being re-drained here.
  private flushOutbound(): void {
    if (!this.ws || this.ws.readyState !== this.ws.OPEN) return;
    const drained = this.outboundQueue;
    this.outboundQueue = [];
    this.outboundOverflowReported = false;
    for (const frame of drained) {
      this.send(frame);
    }
  }

  private onMessage(ev: MessageEvent): void {
    // Stamped before the parse: garbage the server sent is still the server
    // reaching us, and the path carrying bytes is the whole question.
    this.lastInboundAt = Date.now();
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

    // The connection is working, so the reconnect loop starts over.
    //
    // What these have in common is that each ANSWERS something this client
    // sent, which is why they read as the connection working where the rest
    // of the protocol does not: the subscribe handshake is `subscribed` and
    // then `doc_init` or `presence_snapshot`, so a backend that accepts,
    // acks and hangs up would credit itself on every cycle, and an `error`
    // frame is the server reporting it could NOT do the work.
    //
    // Credited as the evidence arrives rather than when the socket ends,
    // because `close()` drops its own socket's `close` event (it nulls
    // `this.ws` first, so the identity guard rejects it) and an app reaches
    // `close()` routinely, so a session that ended that way would credit
    // nothing however well it worked.
    //
    // Getting this wrong is survivable by design: the count decides when the
    // loop slows and reports, not whether it runs at all, so a client this
    // rule misjudges is late to a notification rather than disconnected.
    if (type === 'pong' || type === 'op_ack') {
      this.failedAttempts = 0;
      this.creditsThisSocket += 1;
      if (this.creditsThisSocket >= 2) this.reportedFailing = false;
    }

    if (type === 'subscribed' && typeof frame.topic === 'string') {
      // `flush_held` drains the frames held back for the unacked subscribe.
      this.dispatch(frame.topic, { type: 'subscribed_ack' });
      const acked = this.listeners.get(frame.topic);
      if (acked) {
        for (const meta of acked.values()) {
          const resubscribed = meta.expectGap;
          meta.expectGap = true;
          try {
            meta.onSubscribed?.({ resubscribed });
          } catch {
            // A bad listener must not break the others or kill the read loop.
          }
        }
      }
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
      // The server's catch-all rejection: a deploy without the `ping`
      // handler answers a heartbeat with it, and one without the
      // `client_report` handler answers every sync-health report with it.
      // Swallowed so a version skew is not an error the app sees, and
      // deliberately not credited above, since a client whose every frame is
      // refused would otherwise read its own rejections as a healthy socket.
      if (reason === 'bad_message' && !topic) return;
      if (topic) {
        // The machine decides: silent retry, delivery to the topic's
        // callbacks, swallow, or teardown + `fire_error`. A topic with no
        // live state (already unsubscribed or torn down our side) swallows:
        // the canonical case is a presence-update racing a `doc_gone`
        // eviction, whose late `forbidden` reply would otherwise surface as
        // a misleading "subscribe(...): forbidden" with no subscribe in
        // flight to fail.
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
      this.fanOut(frame.topic, frame);
    }
  }

  private fanOut(topic: string, frame: unknown): void {
    const set = this.listeners.get(topic);
    if (!set) return;
    for (const cb of set.keys()) {
      try {
        cb(frame);
      } catch {
        // A bad listener must not break the others or kill the read loop.
      }
    }
  }

  private onClose(): void {
    this.stopHeartbeat();
    this.ws = null;
    this.lastInboundAt = 0;
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

  // Tell the app the connection is failing, once per incident. `onError`
  // has no dedupe of its own and reaches every listener, so an app that
  // surfaces it would otherwise show the same outage repeatedly: the count
  // is cleared by any credited frame, and a flapping link supplies one every
  // so often, which starts a fresh episode each time.
  private reportFailing(): void {
    if (this.reportedFailing) return;
    this.reportedFailing = true;
    this.opts.fireError(
      new Error(
        `Brass WebSocket subscribe: reconnect failing after ${RECONNECT_MAX_ATTEMPTS} attempts`,
      ),
    );
  }

  private scheduleReconnect(): void {
    this.failedAttempts += 1;
    if (this.failedAttempts >= RECONNECT_MAX_ATTEMPTS) this.reportFailing();
    // Past the threshold the loop SLOWS; it does not stop. Stopping is what
    // makes a wrong verdict expensive: deciding a working connection is dead
    // leaves a reader disconnected with nothing retrying, and every rule for
    // telling a working connection from a failing one has some client it
    // misjudges (a quiet topic draws no traffic, a short socket answers
    // nothing, a flapping backend answers everything). Slowing costs one
    // attempt every few minutes against an endpoint that is genuinely down,
    // and it takes the whole class of "gave up on a healthy network" out of
    // the design rather than out of the current predicate.
    //
    // The slow phase costs a reader who is being served by short sockets:
    // a subscriber that never writes draws no `op_ack`, and a socket that
    // dies before `HEARTBEAT_FIRST_MS` draws no `pong`, so frames pushed to
    // it never speed the loop back up. Measured against a server pushing one
    // event every 30s, that reader receives 4% of them at a 9s socket
    // lifetime where pacing on opening receives 82%. It is the accepted
    // cost: the signal that buys those frames back is one a hangup backend
    // satisfies without carrying anything, which is the 86,000-sockets-a-day
    // trade, and this reader still gets a full `doc_init` resync on every
    // reconnect plus the failing report.
    const delay =
      this.failedAttempts > RECONNECT_MAX_ATTEMPTS
        ? RECONNECT_IDLE_DELAY_MS
        : RECONNECT_DELAYS_MS[
            Math.min(this.failedAttempts - 1, RECONNECT_DELAYS_MS.length - 1)
          ]!;
    // Clear before arming. An out-of-band connect (a `send` during a backoff
    // window) can bring this through a second time with a timer already
    // armed, and the overwritten handle is one `close()` cannot reach: it
    // fires afterwards, and `ensureConnected` re-enters at the front door,
    // clearing `closedByUser` and standing a socket and heartbeat back up.
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // The user may have closed us while this was armed.
      if (this.closedByUser) return;
      void this.ensureConnected();
    }, delay);
  }

  // Foreground return / network recovery: a reader is back, so reconnect
  // promptly with a fresh token rather than waiting out a long delay or
  // staying parked after a bail.
  private resume(): void {
    if (this.closedByUser) return;
    if (this.listeners.size === 0) return;
    if (this.ws && this.ws.readyState === this.ws.OPEN) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failedAttempts = 0;
    this.reportedFailing = false;
    void this.ensureConnected();
  }

  /** Reconnects this client has made: every socket after the first. */
  get reconnectCount(): number {
    return Math.max(0, this.socketsOpened - 1);
  }

  /** Whether the page is hidden right now. */
  get pageHidden(): boolean {
    return this.isHidden();
  }

  /** Whether a socket is open right now. */
  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === this.ws.OPEN;
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
        if (!this.isHidden()) this.resume();
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
    // One handle, re-armed after each ping, so the first delay can differ
    // from the cadence without a second timer to keep in step.
    const arm = (delay: number): void => {
      this.heartbeatTimer = setTimeout(() => {
        // The one thing running on an idle connection, so it is also what
        // notices the socket stopped carrying anything.
        if (this.socketHasGoneSilent()) {
          this.dropSilentSocket();
          return;
        }
        this.sendIfOpen({ type: 'ping' });
        arm(HEARTBEAT_INTERVAL_MS);
      }, delay);
    };
    arm(HEARTBEAT_FIRST_MS);
  }

  private socketHasGoneSilent(): boolean {
    if (!this.ws || this.lastInboundAt === 0) return false;
    return Date.now() - this.lastInboundAt >= this.silenceLimitMs;
  }

  // Retire a socket the server has stopped answering on. `onClose` runs
  // directly rather than being waited for: closing a dead path has nothing to
  // complete the handshake with, so the socket can sit in CLOSING and never
  // fire `close`, which is the state this exists to escape. Running the
  // teardown first also lets the identity guard drop a late `close`, so the
  // reconnect is scheduled once.
  private dropSilentSocket(): void {
    const dead = this.ws;
    this.onClose();
    try {
      dead?.close();
    } catch {
      // Closing an already-dead socket is fine; the teardown already ran.
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
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

// True for a frame the server answers by name, which is what lets a
// subscriber that holds it re-assert exactly that frame later.
function isIdentifiedFrame(frame: unknown): boolean {
  return isObject(frame) && typeof frame['client_op_id'] === 'string';
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
