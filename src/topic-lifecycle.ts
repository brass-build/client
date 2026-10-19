// Pure per-topic subscription lifecycle for `BrassWsClient`. The client
// owns the socket, timers, and frame queues; every decision about a
// topic's subscription (what to send, when to hold or drop queued frames,
// when to surface an error) comes from `step`'s transition table.
//
// Phases:
//   - `idle`: not wanted. Errors and acks for it are ignored.
//   - `subscribing`: wanted, first subscribe on this connection unacked
//     (or not yet sendable). Topic-scoped frames are held until the ack.
//   - `established`: acked; frames flow.
//   - `retrying`: the one silent re-subscribe this connection grants is in
//     flight after a mid-stream `not_subscribed` eviction. Further
//     `not_subscribed` errors describe frames that predate the retry and
//     are swallowed; any other reason is the retry's own rejection.
//   - `tornDown`: rejected or evicted with the retry spent. Terminal until
//     a fresh `user_subscribe` or the next socket transition prunes it.
//     `retrySpent` survives into a same-connection re-subscribe so the
//     retry stays one-per-topic-per-connection.
//
// A frame-scoped reason (`isFrameScopedReason`) is the exception to all of
// that: it describes the frame the server could not process, not the
// subscription it arrived on, so every live phase keeps its state and hands
// the error to the topic's callbacks, which hold the frame that drew it.
// While the subscribe is unacked the subscribe may be the frame that drew it,
// so the client also sends that again after a backoff (a duplicate subscribe
// is idempotent on the server).
//
// A `server_ended` event (the server evicted every subscriber on the topic
// and deleted their rows) returns any phase to `idle` and detaches the
// topic's callbacks, so whoever subscribes next sends a subscribe of its own
// rather than attaching to a subscription the server no longer holds.
//
// Invariant: every transition into `tornDown` emits `send_unsubscribe`,
// so no server-side subscription row can outlive the client-side state
// (an orphan row would have its `last_seen` kept fresh by the heartbeat,
// making it immune to the server's stale reaper).

export type TopicPhase =
  | 'idle'
  | 'subscribing'
  | 'established'
  | 'retrying'
  | 'tornDown';

export interface TopicState {
  phase: TopicPhase;
  // True once this connection's one silent re-subscribe is consumed.
  // Reset by `socket_open`.
  retrySpent: boolean;
}

export const IDLE_TOPIC: TopicState = { phase: 'idle', retrySpent: false };

export type TopicEvent =
  | { type: 'user_subscribe' }
  | { type: 'user_unsubscribe' }
  | { type: 'socket_open' }
  | { type: 'socket_closed' }
  | { type: 'subscribed_ack' }
  | { type: 'server_ended' }
  // The server reports it holds no subscription row for an established topic
  // while the socket stays up (a presence row reaped as stale).
  | { type: 'server_dropped' }
  | { type: 'error'; reason: string };

export type TopicEffect =
  | { kind: 'send_subscribe' }
  // Send the subscribe again after the client's backoff: the server could
  // not finish the one in flight.
  | { kind: 'resend_subscribe_later' }
  | { kind: 'send_unsubscribe' }
  // Flush the frames held for the unacked subscribe, in order.
  | { kind: 'flush_held' }
  | { kind: 'drop_held' }
  // Detach the topic's callbacks: further server frames must not reach
  // them and the user's unsubscribe becomes a no-op.
  | { kind: 'drop_listeners' }
  // Hand the error to the topic's callbacks and leave the subscription
  // alone. The callbacks own whatever frame drew it, so they own the
  // recovery.
  | { kind: 'deliver_error'; reason: string }
  | { kind: 'fire_error'; reason: string };

export interface StepResult {
  state: TopicState;
  effects: TopicEffect[];
}

// True while topic-scoped frames must be held back: sending before the
// `subscribed` ack races the server's subscription record write and draws a spurious
// `forbidden`.
export function holdsFrames(state: TopicState): boolean {
  return state.phase === 'subscribing' || state.phase === 'retrying';
}

// True for a reason that judges one frame rather than the subscription.
// `unavailable` answers a durable op write the server was authorised to
// take and could not store right now, so the topic stays up and the writer
// re-sends the op.
export function isFrameScopedReason(reason: string): boolean {
  return reason === 'unavailable';
}

const SEND_SUBSCRIBE: TopicEffect = { kind: 'send_subscribe' };
const RESEND_SUBSCRIBE_LATER: TopicEffect = { kind: 'resend_subscribe_later' };
const FLUSH_HELD: TopicEffect = { kind: 'flush_held' };
const DROP_HELD: TopicEffect = { kind: 'drop_held' };

function deliverError(state: TopicState, reason: string): StepResult {
  return { state, effects: [{ kind: 'deliver_error', reason }] };
}

// Rejection / spent-retry teardown. `send_unsubscribe` releases any
// server-side row a completed retry may have re-created (the invariant in
// the header); `unsubscribe` is idempotent server-side, so sending it when
// no row exists is safe.
function tearDown(state: TopicState, reason: string): StepResult {
  return {
    state: { phase: 'tornDown', retrySpent: state.retrySpent },
    effects: [
      DROP_HELD,
      { kind: 'drop_listeners' },
      { kind: 'send_unsubscribe' },
      { kind: 'fire_error', reason },
    ],
  };
}

// A (re)opened socket grants a fresh retry and a fresh subscribe.
function reopened(): StepResult {
  return {
    state: { phase: 'subscribing', retrySpent: false },
    effects: [SEND_SUBSCRIBE],
  };
}

function unsubscribed(): StepResult {
  return {
    state: IDLE_TOPIC,
    effects: [DROP_HELD, { kind: 'send_unsubscribe' }],
  };
}

export function step(state: TopicState, event: TopicEvent): StepResult {
  if (event.type === 'server_ended') {
    if (state.phase === 'idle') return { state, effects: [] };
    return { state: IDLE_TOPIC, effects: [DROP_HELD, { kind: 'drop_listeners' }] };
  }
  switch (state.phase) {
    case 'idle':
      if (event.type === 'user_subscribe') {
        return {
          state: { phase: 'subscribing', retrySpent: false },
          effects: [SEND_SUBSCRIBE],
        };
      }
      return { state, effects: [] };

    case 'subscribing':
      switch (event.type) {
        case 'subscribed_ack':
          return {
            state: { ...state, phase: 'established' },
            effects: [FLUSH_HELD],
          };
        case 'error':
          if (isFrameScopedReason(event.reason)) {
            return {
              state,
              effects: [
                { kind: 'deliver_error', reason: event.reason },
                RESEND_SUBSCRIBE_LATER,
              ],
            };
          }
          // Never established on this connection: the rejection is final.
          return tearDown(state, event.reason);
        case 'socket_open':
          return reopened();
        case 'socket_closed':
          return { state, effects: [DROP_HELD] };
        case 'user_unsubscribe':
          return unsubscribed();
        case 'user_subscribe':
          return { state, effects: [] };
      }
      break;

    case 'established':
      switch (event.type) {
        case 'error':
          if (isFrameScopedReason(event.reason)) {
            return deliverError(state, event.reason);
          }
          // A mid-stream `not_subscribed` is an eviction (the server
          // dropped the subscription row while this client stayed alive,
          // e.g. a presence reap that raced a live-but-quiet connection),
          // not a rejection: recover silently with one re-subscribe per
          // connection, keeping the listeners and held-frame queue. Any
          // other reason is a genuine refusal (role, scope, membership)
          // that a re-subscribe would just repeat.
          if (event.reason === 'not_subscribed' && !state.retrySpent) {
            return {
              state: { phase: 'retrying', retrySpent: true },
              effects: [SEND_SUBSCRIBE],
            };
          }
          return tearDown(state, event.reason);
        case 'subscribed_ack':
          return { state, effects: [FLUSH_HELD] };
        // Subscribe again, holding frames until it is acked. It spends no
        // retry: the report arrives once per heartbeat, so it cannot loop.
        case 'server_dropped':
          return { state: { ...state, phase: 'subscribing' }, effects: [SEND_SUBSCRIBE] };
        case 'socket_open':
          return reopened();
        case 'socket_closed':
          return { state: { ...state, phase: 'subscribing' }, effects: [DROP_HELD] };
        case 'user_unsubscribe':
          return unsubscribed();
        case 'user_subscribe':
          return { state, effects: [] };
      }
      break;

    case 'retrying':
      switch (event.type) {
        case 'error':
          if (isFrameScopedReason(event.reason)) {
            return {
              state,
              effects: [
                { kind: 'deliver_error', reason: event.reason },
                RESEND_SUBSCRIBE_LATER,
              ],
            };
          }
          // An eviction draws errors for EVERY frame in flight against the
          // reaped row; the trailing ones land while the retry's subscribe
          // is unacked and describe frames that predate it, so the retry
          // supersedes them. A non-`not_subscribed` reason in this window
          // is the retry's own rejection.
          if (event.reason === 'not_subscribed') {
            return { state, effects: [] };
          }
          return tearDown(state, event.reason);
        case 'subscribed_ack':
          return {
            state: { ...state, phase: 'established' },
            effects: [FLUSH_HELD],
          };
        case 'socket_open':
          return reopened();
        case 'socket_closed':
          return { state: { ...state, phase: 'subscribing' }, effects: [DROP_HELD] };
        case 'user_unsubscribe':
          return unsubscribed();
        case 'user_subscribe':
          return { state, effects: [] };
      }
      break;

    case 'tornDown':
      switch (event.type) {
        case 'user_subscribe':
          // Same-connection re-subscribe: a spent retry stays spent, so
          // the fresh subscribe rides the retrying phase's error handling.
          return {
            state: {
              phase: state.retrySpent ? 'retrying' : 'subscribing',
              retrySpent: state.retrySpent,
            },
            effects: [SEND_SUBSCRIBE],
          };
        case 'socket_open':
        case 'socket_closed':
          return { state: IDLE_TOPIC, effects: [] };
        default:
          return { state, effects: [] };
      }
  }
  return { state, effects: [] };
}
