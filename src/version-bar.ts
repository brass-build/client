// The parent (SDK) half of the version-preview bar's iframe bridge.
//
// Unlike the hosted dialogs (`hosted-ui.ts`, a modal open -> result ->
// close), this mounts the platform-served `/embed/version-bar` page INLINE
// as a persistent strip and keeps a long-lived, bidirectional channel open
// for the whole preview. The platform owns the bar's UI and features
// (Prev / Next, browse, branch-from); the SDK stays a thin router of the
// embed's intents to the active Document's internal methods, so the bar can
// grow with no SDK or app change.
//
// Bridge protocol (shared envelope `__brass_embed: 1`):
//   host -> iframe:  init{surface,params}
//                    | version-changed{version, requestId?, ok?}
//   iframe -> host:  ready | resize{height} | preview{version, requestId?}
//                    | return-to-head{requestId?} | fork{fromVersion} | browse
//                    | error{code,message}
//
// A navigating intent (`preview` / `return-to-head`) is CONFIRMED: the host
// awaits the document method it routes to and answers with the version the
// document actually shows afterwards, plus whether the intent was accepted.
// The bar moves optimistically on the click, so without that answer a refused
// checkout (a document pinned to a version, a materialise that failed) leaves
// it naming a version nothing is showing, and nothing later corrects it: the
// host's own re-render is driven by the session, which does not notify on a
// preview -> preview step.

import { EMBED_ENVELOPE, EMBED_PROTOCOL_VERSION } from './embed-protocol.js';

// Collapsed until the embed reports `ready`, so the load moment shows a
// themed placeholder strip rather than an empty white iframe (no flash, no
// layout jump: the placeholder reserves the strip's height).
const READY_HEIGHT = 44;
const MIN_HEIGHT = 32;
const MAX_HEIGHT = 200;

export interface VersionBarDeps {
  // The resolved dashboard/embed origin (no trailing slash); the iframe
  // loads `${dashboardBaseUrl}/embed/version-bar`.
  dashboardBaseUrl: string;
  // Pins the embed's light/dark theme (matches the other hosted surfaces).
  theme?: 'light' | 'dark' | 'auto';
  // Intents from the embed, routed to the live active document. The two
  // navigating ones settle (a rejection is a refused intent, which the frame
  // reports back rather than swallowing).
  checkoutVersion: (version: number) => Promise<void>;
  returnToHead: () => Promise<void>;
  fork: (fromVersion: number, name?: string) => void;
  browse: () => void;
  // The version the active document shows right now (`null` at the live
  // head). Read after an intent settles, so the answer describes the
  // document rather than the request.
  currentVersion: () => number | null;
  // Dismiss the bar. The bar stays open through the whole browsing session
  // (including once returned to the live head), so it is closed only by the
  // user's explicit "Close", never as a side effect of navigation.
  close: () => void;
}

export interface VersionBarContext {
  docId: string;
  branch: string | undefined;
  // The previewed version, or `null` when the bar is open at the live head
  // (the browsing session has returned to latest but not been closed).
  version: number | null;
  // The active branch's display name when on a non-default branch, else
  // undefined. The bar composes a branch-from-version's initial name from it.
  branchName?: string | undefined;
  // True when the document is pinned to this version and has no live channel
  // (a cold open at a version). Stepping and returning to the head are both
  // refused on that shape, so the bar offers neither.
  pinned?: boolean;
}

export interface VersionBarFrame {
  // Set or update the previewed context. A version change on the same
  // document pushes `version-changed`; a document / branch change re-inits
  // (the embed's `init` is one-shot, so the frame is recreated).
  update(ctx: VersionBarContext): void;
  destroy(): void;
}

function clampHeight(h: number): number {
  if (!Number.isFinite(h)) return READY_HEIGHT;
  return Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(h)));
}

// How long the embed has to say it is ready before the SDK-drawn fallback
// takes the strip. Matches the hosted-UI launcher's own long window.
const VERSION_BAR_READY_TIMEOUT_MS = 10_000;

export function createVersionBarFrame(
  root: HTMLElement,
  deps: VersionBarDeps,
): VersionBarFrame {
  const origin = new URL(deps.dashboardBaseUrl).origin;
  const base = deps.dashboardBaseUrl.replace(/\/$/, '');
  const theme = deps.theme ?? 'light';

  // A themed placeholder strip shown until the embed is ready, so the bar
  // occupies its height immediately (graceful load, no flash).
  const placeholder = document.createElement('div');
  placeholder.className = 'b-version-loading';
  placeholder.textContent = 'Loading version controls...';

  // Shown when the embed reports it cannot render (not signed in in this
  // framing context, an account mismatch). The bar is the only surface that
  // returns a document to its live head, so collapsing the strip on that
  // failure would leave the reader in a read-only preview with nothing to
  // leave it by; this carries the two controls that need no timeline.
  const fallback = document.createElement('div');
  fallback.className = 'b-version-fallback';
  fallback.hidden = true;
  const fallbackText = document.createElement('span');
  fallbackText.className = 'b-version-fallback-msg';
  const fallbackHead = document.createElement('button');
  fallbackHead.type = 'button';
  fallbackHead.textContent = 'Return to latest';
  fallbackHead.onclick = () => {
    void deps.returnToHead().catch(() => {});
  };
  const fallbackClose = document.createElement('button');
  fallbackClose.type = 'button';
  fallbackClose.textContent = 'Close';
  fallbackClose.onclick = () => deps.close();
  fallback.append(fallbackText, fallbackHead, fallbackClose);

  function renderFallback(): void {
    const pinned = ctx?.pinned === true;
    const previewing = deps.currentVersion() !== null;
    fallbackText.textContent = previewing
      ? 'Viewing an earlier version'
      : 'Latest version';
    fallbackHead.hidden = !previewing || pinned;
  }

  const iframe = document.createElement('iframe');
  const url = new URL(`${base}/embed/version-bar`);
  url.searchParams.set('theme', theme);
  iframe.src = url.toString();
  iframe.title = 'Document version';
  Object.assign(iframe.style, {
    display: 'block',
    border: '0',
    width: '100%',
    height: '0',
    colorScheme: theme === 'auto' ? 'light dark' : theme,
    background: 'transparent',
  } satisfies Partial<CSSStyleDeclaration>);

  root.append(placeholder, fallback, iframe);

  let ctx: VersionBarContext | null = null;
  let ready = false;
  // Set once the embed reports it cannot render, so the fallback strip owns
  // the surface and a later `update` does not restore the dead iframe.
  let failed = false;
  let destroyed = false;
  // Armed whenever the iframe is pointed at the embed. Returning a document to
  // its live head is this bar's exclusive capability, so an embed that never
  // loads at all (a host CSP that refuses the frame, an offline reader, a
  // blocking extension) would otherwise leave the placeholder up forever and
  // the reader in a read-only preview with no control to leave it by. The
  // `error` message covers an embed that loaded and refused; nothing covers
  // one that never answers, which is why this is a timer rather than a
  // handler.
  let readyTimer: ReturnType<typeof setTimeout> | undefined;

  // Hand the strip to the SDK-drawn fallback, which carries the two controls
  // that need no timeline (return to latest, close).
  function enterFallback(): void {
    if (destroyed || failed) return;
    failed = true;
    if (readyTimer !== undefined) {
      clearTimeout(readyTimer);
      readyTimer = undefined;
    }
    placeholder.style.display = 'none';
    iframe.style.height = '0';
    fallback.hidden = false;
    renderFallback();
  }

  function armReadyTimer(): void {
    if (readyTimer !== undefined) clearTimeout(readyTimer);
    readyTimer = setTimeout(() => {
      readyTimer = undefined;
      if (!ready) enterFallback();
    }, VERSION_BAR_READY_TIMEOUT_MS);
  }
  // The version last delivered to the embed (via `init` or `version-changed`).
  // The host re-renders on many events (a commit, a saving-count bump, ...),
  // each calling `update`, but only an ACTUAL version change should reach the
  // embed. Posting on every render would flood the bar with echoes and let a
  // stale one clobber its optimistic state; `undefined` = nothing delivered yet.
  let deliveredVersion: number | null | undefined = undefined;

  function postInit(): void {
    if (!ctx) return;
    iframe.contentWindow?.postMessage(
      {
        [EMBED_ENVELOPE]: EMBED_PROTOCOL_VERSION,
        type: 'init',
        surface: 'version-bar',
        params: {
          docId: ctx.docId,
          ...(ctx.branch !== undefined ? { branch: ctx.branch } : {}),
          version: ctx.version,
          ...(ctx.branchName !== undefined ? { branchName: ctx.branchName } : {}),
          ...(ctx.pinned ? { pinned: true } : {}),
        },
      },
      origin,
    );
    deliveredVersion = ctx.version;
  }

  // Answer a navigating intent with what the document shows now. `ok` is
  // whether the intent itself was accepted, which the version alone cannot
  // say: a checkout the server rounded down and one that was refused both
  // report a version other than the requested one, and the bar keeps the
  // reader's step position for the first and reverts it for the second.
  function confirmIntent(requestId: unknown, ok: boolean): void {
    // An intent settles a turn after it was routed, by which time the bar may
    // have been torn down (the reader closed it, the document changed). There
    // is nothing listening then, and posting into a removed frame is an error
    // that would surface as an unhandled rejection in the app.
    if (!ready || destroyed) return;
    const version = deps.currentVersion();
    deliveredVersion = version;
    iframe.contentWindow?.postMessage(
      {
        [EMBED_ENVELOPE]: EMBED_PROTOCOL_VERSION,
        type: 'version-changed',
        version,
        ok,
        ...(typeof requestId === 'string' ? { requestId } : {}),
      },
      origin,
    );
  }

  // Intents still awaiting their answer. While one is in flight, `update()`
  // stays quiet: the checkout it runs fires the host's subscribers before its
  // promise resolves, so a render lands here ahead of `confirmIntent`, and an
  // uncorrelated `version-changed` posted then reaches the embed as a phantom
  // external move one message before the answer to its own step. The answer
  // reads the live version at settle time, so nothing the quiet window saw is
  // lost.
  let intentsInFlight = 0;

  function runIntent(requestId: unknown, intent: () => Promise<void>): void {
    intentsInFlight += 1;
    const settle = (ok: boolean) => (): void => {
      // Decremented in every outcome. A count this leaves above zero silences
      // `update()` for the life of the bar, so an external version change
      // would never reach the embed again.
      intentsInFlight -= 1;
      confirmIntent(requestId, ok);
    };
    void intent().then(settle(true), settle(false));
  }

  function onMessage(event: MessageEvent): void {
    if (event.origin !== origin) return;
    if (event.source !== iframe.contentWindow) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data[EMBED_ENVELOPE] !== EMBED_PROTOCOL_VERSION) return;
    switch (data['type']) {
      case 'ready': {
        ready = true;
        if (readyTimer !== undefined) {
          clearTimeout(readyTimer);
          readyTimer = undefined;
        }
        placeholder.style.display = 'none';
        iframe.style.height = `${READY_HEIGHT}px`;
        postInit();
        break;
      }
      case 'resize': {
        const h = data['height'];
        if (typeof h === 'number') iframe.style.height = `${clampHeight(h)}px`;
        break;
      }
      case 'preview': {
        const v = data['version'];
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
          runIntent(data['requestId'], () => deps.checkoutVersion(v));
        }
        break;
      }
      case 'return-to-head': {
        runIntent(data['requestId'], () => deps.returnToHead());
        break;
      }
      case 'fork': {
        const v = data['fromVersion'];
        const name = data['name'];
        if (typeof v === 'number' && Number.isInteger(v) && v >= 0) {
          deps.fork(v, typeof name === 'string' && name ? name : undefined);
        }
        break;
      }
      case 'browse': {
        deps.browse();
        break;
      }
      case 'close': {
        deps.close();
        break;
      }
      case 'error': {
        // The embed loaded and reported it cannot render (not signed in in
        // this context, an account mismatch).
        enterFallback();
        break;
      }
    }
  }

  // Armed here rather than beside the `src` assignment above, which runs
  // before `readyTimer` is initialised.
  armReadyTimer();
  window.addEventListener('message', onMessage);

  return {
    update(next: VersionBarContext): void {
      const prev = ctx;
      ctx = next;
      // A document / branch switch needs a fresh `init`, which the embed
      // only honors once, so recreate on that; a same-doc version step
      // just pushes the new version down.
      if (prev && (prev.docId !== next.docId || prev.branch !== next.branch)) {
        // Reload the iframe: reset ready, restore the placeholder, and the
        // new page will `ready` -> we re-`init` with the new context. A fresh
        // page gets a fresh verdict, so the failed state resets with it.
        ready = false;
        failed = false;
        deliveredVersion = undefined;
        fallback.hidden = true;
        placeholder.style.display = '';
        iframe.style.height = '0';
        iframe.src = url.toString();
        armReadyTimer();
        return;
      }
      if (failed) {
        renderFallback();
        return;
      }
      // Only an actual version change reaches the embed (dedup), so a
      // re-render that didn't move the version can't clobber the bar's state.
      // A change while an intent is in flight is that intent's own doing and
      // is delivered by its answer instead.
      if (ready && intentsInFlight === 0 && next.version !== deliveredVersion) {
        deliveredVersion = next.version;
        iframe.contentWindow?.postMessage(
          { [EMBED_ENVELOPE]: EMBED_PROTOCOL_VERSION, type: 'version-changed', version: next.version },
          origin,
        );
      }
    },
    destroy(): void {
      destroyed = true;
      // A bar torn down mid-intent leaves the count standing; a rebuilt bar
      // gets a fresh closure, but this keeps the teardown total.
      intentsInFlight = 0;
      if (readyTimer !== undefined) {
        clearTimeout(readyTimer);
        readyTimer = undefined;
      }
      window.removeEventListener('message', onMessage);
      iframe.remove();
      placeholder.remove();
      fallback.remove();
    },
  };
}
