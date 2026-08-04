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
//   host -> iframe:  init{surface,params} | version-changed{version}
//   iframe -> host:  ready | resize{height} | preview{version}
//                    | return-to-head | fork{fromVersion} | browse
//                    | error{code,message}

const ENVELOPE = '__brass_embed';
const PROTOCOL_VERSION = 1;
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
  // The fallback platform-session pointer, handed to the embed so it can
  // authenticate when its framed cookie is blocked (incognito / Safari ITP).
  getSessionToken?: () => string | null | undefined;
  // Intents from the embed, routed to the live active document.
  checkoutVersion: (version: number) => void;
  returnToHead: () => void;
  fork: (fromVersion: number, name?: string) => void;
  browse: () => void;
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

  root.append(placeholder, iframe);

  let ctx: VersionBarContext | null = null;
  let ready = false;
  // The version last delivered to the embed (via `init` or `version-changed`).
  // The host re-renders on many events (a commit, a saving-count bump, ...),
  // each calling `update`, but only an ACTUAL version change should reach the
  // embed. Posting on every render would flood the bar with echoes and let a
  // stale one clobber its optimistic state; `undefined` = nothing delivered yet.
  let deliveredVersion: number | null | undefined = undefined;

  function postInit(): void {
    const sid = deps.getSessionToken?.();
    if (!ctx) return;
    iframe.contentWindow?.postMessage(
      {
        [ENVELOPE]: PROTOCOL_VERSION,
        type: 'init',
        surface: 'version-bar',
        params: {
          docId: ctx.docId,
          ...(ctx.branch !== undefined ? { branch: ctx.branch } : {}),
          version: ctx.version,
          ...(ctx.branchName !== undefined ? { branchName: ctx.branchName } : {}),
          ...(sid ? { sessionToken: sid } : {}),
        },
      },
      origin,
    );
    deliveredVersion = ctx.version;
  }

  function onMessage(event: MessageEvent): void {
    if (event.origin !== origin) return;
    if (event.source !== iframe.contentWindow) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || data[ENVELOPE] !== PROTOCOL_VERSION) return;
    switch (data['type']) {
      case 'ready': {
        ready = true;
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
          deps.checkoutVersion(v);
        }
        break;
      }
      case 'return-to-head': {
        deps.returnToHead();
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
        // The embed could not render (e.g. not signed in in this context).
        // Collapse rather than leave a dead strip; the app still gates its
        // own editing on `doc.readOnly`.
        placeholder.style.display = 'none';
        iframe.style.height = '0';
        break;
      }
    }
  }

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
        // new page will `ready` -> we re-`init` with the new context.
        ready = false;
        deliveredVersion = undefined;
        placeholder.style.display = '';
        iframe.style.height = '0';
        iframe.src = url.toString();
        return;
      }
      // Only an actual version change reaches the embed (dedup), so a
      // re-render that didn't move the version can't clobber the bar's state.
      if (ready && next.version !== deliveredVersion) {
        deliveredVersion = next.version;
        iframe.contentWindow?.postMessage(
          { [ENVELOPE]: PROTOCOL_VERSION, type: 'version-changed', version: next.version },
          origin,
        );
      }
    },
    destroy(): void {
      window.removeEventListener('message', onMessage);
      iframe.remove();
      placeholder.remove();
    },
  };
}
