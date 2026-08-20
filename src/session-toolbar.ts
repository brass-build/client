// The SDK-rendered document chrome, as composable pieces. The SDK owns the
// DOM, look, and behaviour; the app provides a container and (optionally) its
// own tool buttons.
//
// Three granularities from one implementation:
//   - `createSessionToolbar` mounts the whole bar.
//   - `createSessionHeader` mounts the empty shell and hands back its three
//     slots (`start` / `tools` / `end`) for an app that fills them itself.
//   - the per-piece mounts each render one cluster into the app's element.
//
// The header layout has ONE definition (`buildBarShell`), shared by the
// whole-bar and slot-only mounts, so a composable app gets the same
// avatar-stays-top-right wrapping the full bar has.
//
// These widgets only render chrome and route to the hosted dialogs; they
// never mint a grant themselves.

import type { BrassUser } from './types.js';
import type { Command, Document as BrassDocument } from './documents.js';
import type { DocumentSession } from './session.js';
import type { PresenceParticipant } from './presence.js';
import type {
  DocumentDriveStatus,
  DrivePublishTarget,
} from './document-signals.js';
import {
  createVersionBarFrame,
  type VersionBarDeps,
  type VersionBarFrame,
} from './version-bar.js';

// Injected capabilities, split per piece so each widget declares what it
// reads. Each is structurally satisfied by the full `SessionToolbarDeps`, and
// the narrow interfaces keep widgets unit-testable.
export interface FileMenuDeps {
  session: DocumentSession;
}

export interface DocumentTitleDeps {
  session: DocumentSession;
  // Resolve the active doc's server-authored location label (rendered
  // verbatim by the chip; null when the doc is loose).
  getDocument: (docId: string) => Promise<{ location_label: string | null }>;
}

export interface UndoRedoDeps {
  session: DocumentSession;
}

export interface PresenceRosterDeps {
  session: DocumentSession;
}

export interface DriveSyncDeps {
  session: DocumentSession;
}

export interface VersionPreviewDeps {
  session: DocumentSession;
  // Resolved dashboard/embed origin (no trailing slash): the version bar
  // iframe loads `${dashboardBaseUrl}/embed/version-bar`.
  dashboardBaseUrl: string;
  // Pins the embed's light/dark theme (matches the other hosted surfaces).
  hostedUiTheme?: 'light' | 'dark' | 'auto';
}

export interface AccountMenuDeps {
  getUser: () => BrassUser | null;
  onUserChange: (listener: (user: BrassUser | null) => void) => () => void;
  signIn: () => void;
  signOut: () => void;
  // Base URL of the Brass dashboard, for the account menu's "Open Brass
  // dashboard" link. The client's resolved dashboard origin (picks the
  // environment), with no trailing slash.
  dashboardBaseUrl: string;
}

export type SessionToolbarDeps = FileMenuDeps &
  DocumentTitleDeps &
  UndoRedoDeps &
  PresenceRosterDeps &
  AccountMenuDeps &
  VersionPreviewDeps;

export interface SessionToolbarOptions {
  // Show the presence roster (default true).
  presence?: boolean;
  // Show the account avatar menu (default true).
  account?: boolean;
  // Show the drive-sync indicator (default true). Renders nothing unless the
  // active doc is drive-linked, so it is harmless for a non-drive app; set
  // false only to suppress it on a drive doc.
  drive?: boolean;
}

// A mounted piece. `destroy()` unsubscribes and clears the container.
export interface MountedPiece {
  destroy(): void;
}

export interface SessionToolbarHandle {
  // A container the app fills with its own tool buttons (e.g. a 3D
  // app's Orbit / Draw). Sits in the middle of the bar on wide screens
  // and drops to its own row on narrow ones.
  readonly tools: HTMLElement;
  // Tear down: unsubscribe and remove the rendered DOM.
  destroy(): void;
}

// The bare header shell: the bar's three layout clusters, mounted empty for an
// app that fills them itself.
export interface SessionHeaderHandle {
  // Left cluster (file menu / title): ellipsizes rather than wraps, so it
  // never pushes `end` to a new row.
  readonly start: HTMLElement;
  // Middle cluster (the app's tool buttons, plus undo/redo if mounted here):
  // centered on wide screens, drops to its own row on narrow ones.
  readonly tools: HTMLElement;
  // Right cluster (presence roster / account avatar): pinned to row 1
  // top-right; never wraps even when `tools` does.
  readonly end: HTMLElement;
  // Remove the shell. The app destroys the pieces it mounted (each returns its
  // own `destroy`).
  destroy(): void;
}

const STYLE_ID = 'brass-toolbar-styles';

// Scoped, theme-aware styles, injected once per document. Every piece root
// carries `brass-ui` (theme tokens + base font, so a standalone piece styles
// itself); `.brass-bar` only adds the flex header layout. Light/dark follows
// the OS.
const CSS = `
.brass-ui { --brass-surface:#161b22; --brass-surface-2:#1f2730;
  --brass-fg:#e6edf3; --brass-fg-muted:#9da7b3; --brass-border:#2a313b;
  --brass-accent:#3b82f6; --brass-accent-fg:#fff; --brass-danger:#e5534b;
  color:var(--brass-fg);
  font:14px system-ui,-apple-system,Segoe UI,Roboto,sans-serif; box-sizing:border-box; }
@media (prefers-color-scheme: light) { .brass-ui {
  --brass-surface:#fff; --brass-surface-2:#f1f3f5; --brass-fg:#1b1f24;
  --brass-fg-muted:#5c636a; --brass-border:#d8dee4; --brass-danger:#cf222e; } }
.brass-ui *, .brass-bar * { box-sizing:border-box; }
/* Host apps commonly set a global button min-height for touch targets, which
   overrides the avatar's height regardless of specificity and stretches the
   32px circle into an oval. Zero the inherited sizing constraints so each
   widget's explicit dimensions hold. */
.brass-ui button, .brass-bar button { min-width:0; min-height:0; }
/* width:100% is load-bearing: mounted as a flex item the bar would otherwise
   shrink to content width (flex stretches only the cross axis). */
.brass-bar { width:100%; display:flex; flex-wrap:wrap; align-items:center; gap:10px;
  padding:8px 12px; background:var(--brass-surface);
  border-bottom:1px solid var(--brass-border); }
/* flex-wrap breaks lines on each item's basis/content size, not its
   shrunk-to-min size, so a wide left cluster would push the avatar onto its
   own line even though both fit after shrinking. flex-basis:0 on the left
   removes it from that line-fill calc, so the avatar stays on row 1 top-right
   and the left ellipsizes instead; the toolbar commands wrap via
   flex-basis:100%. */
.brass-bar .b-left { display:flex; align-items:center; gap:10px; order:1;
  min-width:0; flex:1 1 0; overflow:hidden; }
.brass-bar .b-right { display:flex; align-items:center; gap:8px; order:2;
  flex:0 0 auto; }
.brass-bar .b-tools { display:flex; align-items:center; gap:6px; flex-wrap:wrap;
  order:3; flex-basis:100%; }
/* margin-left:auto pins the avatar right independent of the tools cluster:
   with no doc open the empty tools cluster is hidden (updateToolsVisibility),
   so nothing grows to push the avatar over and it would bunch up by the title.
   It doesn't fight the centered tools: grow resolves before auto margins, so a
   visible flex:1 tools cluster consumes the slack and the margin collapses. */
@media (min-width:760px) { .brass-bar .b-left { flex:0 1 auto; }
  .brass-bar .b-tools { order:2; flex:1; flex-basis:auto;
  justify-content:center; } .brass-bar .b-right { order:3; margin-left:auto; } }
.b-menu { display:inline-flex; }
/* A bare hamburger glyph, no button chrome (background / border / radius), so it
   reads as an icon sitting beside the document title. The 36px box is only an
   invisible tap target; the glyph is sized up so it holds its weight next to the
   14px title. Hover tints the glyph since there's no border to highlight. */
.b-burger { cursor:pointer; width:36px; height:36px;
  display:inline-flex; align-items:center; justify-content:center; border-radius:0;
  border:none; background:none;
  color:var(--brass-fg); font-size:24px; line-height:1; padding:0; font-family:inherit; }
.b-burger:hover { color:var(--brass-accent); }
/* Top-layer dropdown for the file and account menus: rendered via the Popover
   API with fixed JS coords so an ancestor's overflow can't clip it (the file
   menu lives in the bar's overflow:hidden left cluster). */
.b-pop { position:fixed; inset:auto; margin:0; padding:6px;
  list-style:none; background:var(--brass-surface); border:1px solid var(--brass-border);
  border-radius:8px; display:none; flex-direction:column; gap:2px; min-width:200px;
  z-index:2147483646; box-shadow:0 8px 24px rgba(0,0,0,.35); color:var(--brass-fg); }
.b-pop:popover-open { display:flex; }
.b-pop button, .b-pop a { display:block; width:100%; text-align:left;
  background:transparent; border:none; color:var(--brass-fg); padding:8px 10px;
  border-radius:6px; cursor:pointer; font:inherit; text-decoration:none; }
.b-pop button:hover:not(:disabled), .b-pop a:hover { background:var(--brass-surface-2); }
.b-pop button:disabled { opacity:.5; cursor:default; }
/* The rule between command families. A host app's global hr styling would
   otherwise land a thick default rule in a 200px menu, so every side is
   declared here. */
.b-pop .b-sep { height:0; border:none; border-top:1px solid var(--brass-border);
  margin:4px 2px; }
/* [hidden] must beat the block rule above (the account menu swaps its body
   between signed-in actions and the guest's "Sign in"). */
.b-pop button[hidden], .b-pop a[hidden], .b-pop .b-email[hidden] { display:none; }
.b-identity { display:flex; flex-direction:column; align-items:flex-start;
  gap:1px; min-width:0; }
/* Cancels the horizontal padding the title and location carry for their focus
   rings, so the identity block's text still lines up where it would with none.
   Safe inside the bar, where the burger and its 10px gap sit to the left. */
.brass-bar .b-identity { margin-left:-3px; }
.b-titlerow { display:flex; align-items:center; gap:6px;
  max-width:44vw; min-width:0; overflow:hidden; }
/* The title and location are chrome-stripped text buttons (no background /
   border). A host app's global button border-radius still bleeds in, and the
   title's overflow:hidden (for ellipsis) makes that radius clip the glyph
   corners into a rounded nibble; zero it so the text renders whole. */
.b-title { font-weight:600; font-size:14px; line-height:1.2; color:var(--brass-fg);
  flex:0 1 auto; min-width:3em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
  background:none; border:none; border-radius:0; padding:1px 3px; cursor:pointer; font-family:inherit; }
.b-title:hover { text-decoration:underline; text-underline-offset:2px; }
.b-branch { flex:0 0 auto; max-width:12em; font-size:11px; font-weight:600;
  line-height:1.4; color:var(--brass-accent); background:var(--brass-surface-2);
  border:1px solid var(--brass-accent); border-radius:6px; padding:0 6px;
  margin:0; cursor:pointer; font-family:inherit; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.b-branch:hover { background:var(--brass-accent); color:var(--brass-accent-fg); }
.b-loc { font-size:11px; line-height:1.2; color:var(--brass-fg-muted);
  background:none; border:none; border-radius:0; padding:1px 3px; min-height:0; cursor:pointer; white-space:nowrap;
  font-family:inherit; }
.b-loc:hover { color:var(--brass-fg); }
.b-loc.filed::before { content:'📁 '; }
.b-loc.loose { text-decoration:underline dashed; text-underline-offset:2px; }
.b-loc.loose::before { content:'+ '; }
.b-undo-redo { display:inline-flex; align-items:center; gap:6px; }
.b-tool { background:var(--brass-surface-2); color:var(--brass-fg);
  border:1px solid var(--brass-border); border-radius:8px; padding:8px 12px; cursor:pointer; font:inherit; }
.b-tool:disabled { opacity:.5; cursor:default; }
.b-roster { display:flex; gap:4px; }
.b-pip { flex:0 0 auto; width:24px; height:24px; border-radius:50%; display:inline-flex;
  align-items:center; justify-content:center; color:#fff; font-size:11px; font-weight:600;
  overflow:hidden; }
/* A collaborator's avatar fills the pip; object-fit:cover keeps it
   undistorted. Absent or broken, the pip falls back to its coloured initial. */
.b-pip-img { width:100%; height:100%; object-fit:cover; display:block; }
/* flex:0 0 auto so a tight header row never shrinks the avatar's width below
   its fixed height; pairing that with the host-button reset above keeps it a
   true circle (equal width + height) regardless of host CSS or available
   width. */
.b-avatar { flex:0 0 auto; cursor:pointer; width:32px; height:32px; border-radius:50%; border:none;
  display:inline-flex; align-items:center; justify-content:center; background:var(--brass-accent);
  color:var(--brass-accent-fg); font-size:13px; font-weight:600; padding:0; font-family:inherit;
  overflow:hidden; }
/* The uploaded avatar image fills the circle; object-fit:cover keeps it
   undistorted. It sits over the monogram, which stays in the DOM as the
   fallback shown when no image is set or the image fails to load. */
.b-avatar-img { width:100%; height:100%; object-fit:cover; display:block; }
.b-avatar-img[hidden], .b-avatar-initial[hidden] { display:none; }
/* The account menu opens on the identity it acts for: the avatar again at
   reading size, the name, and the email under it. The rows below are the
   actions on that identity, so they carry a glyph and sit apart from the
   header behind a rule. */
.b-account .b-pop { min-width:236px; max-width:min(300px, calc(100vw - 16px)); }
.b-account-head { display:flex; align-items:center; gap:10px; padding:6px 8px 8px; }
.b-account-face { flex:0 0 auto; width:36px; height:36px; border-radius:50%;
  display:inline-flex; align-items:center; justify-content:center; overflow:hidden;
  background:var(--brass-accent); color:var(--brass-accent-fg);
  font-size:15px; font-weight:600; }
/* minmax(0,1fr) so a long name or email ellipsizes instead of widening the
   menu: a grid item's default min-width is its content's intrinsic size. */
.b-account-id { display:grid; grid-template-columns:minmax(0,1fr); gap:1px; min-width:0; }
.b-account-name, .b-email { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.b-account-name { font-size:13px; font-weight:600; line-height:1.3; }
.b-email { color:var(--brass-fg-muted); font-size:12px; line-height:1.3; }
.b-account .b-pop button, .b-account .b-pop a {
  display:flex; align-items:center; gap:10px; font-size:13px; }
.b-account .b-pop svg { flex:0 0 auto; color:var(--brass-fg-muted); }
.b-account .b-pop button:hover svg, .b-account .b-pop a:hover svg { color:var(--brass-fg); }
/* Restated at this specificity so the flex rows above don't unhide a row the
   guest / signed-in swap hides. */
.b-account .b-pop button[hidden], .b-account .b-pop a[hidden],
.b-account .b-pop .b-account-head[hidden], .b-account .b-pop .b-sep[hidden] { display:none; }
/* Drive sync: a dim link icon at rest, accent (or danger) with a dot when
   there is something to do. Clicking opens a top-layer Popover (never clipped
   by the header overflow, light-dismissed on outside tap). */
.b-drive { display:inline-flex; }
.b-drive[hidden] { display:none; }
.b-drive-icon { position:relative; cursor:pointer; width:30px; height:30px;
  display:inline-flex; align-items:center; justify-content:center; border-radius:8px;
  background:transparent; border:none; padding:0; color:var(--brass-fg-muted); }
.b-drive-icon:hover { background:var(--brass-surface-2); color:var(--brass-fg); }
.b-drive.has-changes .b-drive-icon { color:var(--brass-accent); }
.b-drive.is-broken .b-drive-icon { color:var(--brass-danger); }
.b-drive-dot { display:none; position:absolute; top:5px; right:5px; width:7px; height:7px;
  border-radius:50%; background:var(--brass-accent); border:1.5px solid var(--brass-surface); }
.b-drive.has-changes .b-drive-dot, .b-drive.is-broken .b-drive-dot { display:block; }
.b-drive.is-broken .b-drive-dot { background:var(--brass-danger); }
/* Top-layer popover, fixed JS coords clamped to the viewport (inset:auto
   undoes the UA centering). Default display:none keeps it hidden on the
   fallback path; the two show rules stay SEPARATE so an engine without
   :popover-open still honors .b-drive-open. */
.b-drive-pop { position:fixed; margin:0; inset:auto; padding:6px;
  background:var(--brass-surface); border:1px solid var(--brass-border); border-radius:8px;
  display:none; flex-direction:column; gap:2px; z-index:2147483646;
  min-width:220px; max-width:min(320px, calc(100vw - 16px));
  box-shadow:0 8px 24px rgba(0,0,0,.35); color:var(--brass-fg); }
.b-drive-pop:popover-open { display:flex; }
.b-drive-pop.b-drive-open { display:flex; }
.b-drive-pop button { width:100%; text-align:left; background:transparent; border:none;
  color:var(--brass-fg); padding:8px 10px; border-radius:6px; cursor:pointer;
  font:inherit; font-size:13px; }
.b-drive-pop button:hover { background:var(--brass-surface-2); }
.b-drive-head { display:flex; align-items:baseline; gap:8px; padding:6px 10px 2px; }
.b-drive-source { font-size:12px; color:var(--brass-accent); text-decoration:none; white-space:nowrap; }
.b-drive-source:hover { text-decoration:underline; }
.b-drive-detail { margin:0; padding:0 10px 6px; font-size:12px; color:var(--brass-fg-muted); }
/* The drive rejecting a published file is the one line in this panel that
   reports a problem, so it carries the danger tone rather than the muted one
   every other line uses. */
.b-drive-unreadable { margin:0; padding:0 10px 6px; font-size:12px; color:var(--brass-danger, #b3261e); }
/* Historical-version preview bar: a full-width strip the toolbar shows below
   the bar whenever the active doc is previewing an earlier version. The strip
   itself is the platform-served version-bar iframe (the SDK owns only this
   container + the load placeholder); it is collapsed (display:none) unless
   previewing. The placeholder reserves the strip's height during the iframe
   load so there is no white flash or layout jump. Neutral surface tones
   (theme-aware via the toolbar tokens) so the load moment reads as chrome,
   not an alert. */
.b-version { width:100%; display:none; }
.b-version.b-version-on { display:block; }
.b-version-loading { display:flex; align-items:center; width:100%;
  min-height:44px; padding:0 14px; font-size:13px;
  background:var(--brass-surface-2); color:var(--brass-fg-muted);
  border-bottom:1px solid var(--brass-border); }
.b-version iframe { display:block; }
/* The SDK-drawn strip that stands in when the embed reports it cannot render.
   Same box as the placeholder, plus the two controls that need no version
   timeline, so returning to the live head stays reachable. */
.b-version-fallback { display:flex; align-items:center; gap:8px; width:100%;
  min-height:44px; padding:0 14px; font-size:13px;
  background:var(--brass-surface-2); color:var(--brass-fg-muted);
  border-bottom:1px solid var(--brass-border); box-sizing:border-box; }
.b-version-fallback[hidden] { display:none; }
/* Takes the strip's slack, so the controls hold the trailing edge whichever
   of them is showing, and it is the only part that ellipsizes. */
.b-version-fallback-msg { flex:1 1 auto; min-width:0; overflow:hidden;
  text-overflow:ellipsis; white-space:nowrap; }
.b-version-fallback button { flex:0 0 auto; background:transparent;
  border:1px solid var(--brass-border); border-radius:6px; cursor:pointer;
  color:var(--brass-fg); font:inherit; font-size:12px; padding:4px 10px; }
.b-version-fallback button:hover { background:var(--brass-surface); }
.b-version-fallback button[hidden] { display:none; }
/* Keyboard focus. The bar's controls draw the ring INSIDE their own border box
   (negative outline-offset), because the left cluster and the title row clip
   their overflow so a long name ellipsizes: a ring outside the box falls in
   that clipped strip, leaving the burger without its top and bottom edges, the
   location button without its right edge, and the title, which fills the row,
   without any. The chrome-stripped text buttons carry the padding the inset
   ring needs to clear their glyphs. */
.b-burger:focus-visible, .b-title:focus-visible, .b-branch:focus-visible,
.b-loc:focus-visible, .b-tool:focus-visible, .b-avatar:focus-visible,
.b-drive-icon:focus-visible {
  outline:2px solid var(--brass-accent); outline-offset:-2px; }
/* The avatar is filled with the accent and the branch chip is bordered with it
   and fills with it on hover, so an accent ring reads there as part of the
   control. Both take the foreground tone, which holds against the accent fill
   and against their own surface. */
.b-avatar:focus-visible, .b-branch:focus-visible { outline-color:var(--brass-fg); }
/* A top-layer popover is clipped by nothing, so its rows keep the ring outside
   the box, clear of the label. */
.b-pop button:focus-visible, .b-pop a:focus-visible,
.b-drive-pop button:focus-visible, .b-drive-source:focus-visible {
  outline:2px solid var(--brass-accent); outline-offset:2px; }
`;

function injectStyles(doc: Document): void {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  doc.head.appendChild(style);
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function initialOf(user: BrassUser): string {
  const label = user.display_name ?? user.email ?? user.sub;
  return label.trim().charAt(0).toUpperCase() || '?';
}

// A user's face: the uploaded image over a monogram. The monogram is the
// fallback, shown when the user has no avatar image and restored if the image
// fails to load (a broken / unreachable URL renders the initial, never a
// broken-image glyph). The caller places the pair inside its own circle, so
// the account menu's trigger and its header draw the same face at two sizes.
function buildAvatarFace(): {
  nodes: [HTMLImageElement, HTMLSpanElement];
  render(user: BrassUser | null): void;
} {
  const img = el('img', 'b-avatar-img');
  img.alt = '';
  const initial = el('span', 'b-avatar-initial');
  const showMonogram = (): void => {
    img.hidden = true;
    initial.hidden = false;
  };
  img.addEventListener('error', () => {
    img.removeAttribute('src');
    showMonogram();
  });
  return {
    nodes: [img, initial],
    render(user: BrassUser | null): void {
      initial.textContent = user ? initialOf(user) : '?';
      const url = user?.avatar_url?.trim() ?? '';
      if (!url) {
        img.removeAttribute('src');
        showMonogram();
        return;
      }
      if (img.getAttribute('src') !== url) img.src = url;
      img.hidden = false;
      initial.hidden = true;
    },
  };
}

function renderCommandButton(cmd: Command, asTool: boolean): HTMLButtonElement {
  const b = el('button', asTool ? 'b-tool' : undefined);
  b.type = 'button';
  b.textContent = cmd.label;
  b.disabled = !cmd.enabled || cmd.running;
  return b;
}

// Place a top-layer (position:fixed) popover under its anchor, clamped to the
// viewport so a wide one near an edge never runs off-screen. `align` picks the
// edge it lines up with the anchor: `start` (left) or `end` (right).
function positionPopover(
  anchor: HTMLElement,
  pop: HTMLElement,
  align: 'start' | 'end',
): void {
  const r = anchor.getBoundingClientRect();
  const margin = 8;
  const pw = pop.offsetWidth || 200;
  const ph = pop.offsetHeight || 0;
  let left = align === 'end' ? r.right - pw : r.left;
  left = Math.min(left, window.innerWidth - pw - margin);
  left = Math.max(margin, left);
  let top = r.bottom + 4;
  // Flip above the anchor when there is no room below but room above.
  if (top + ph > window.innerHeight - margin && r.top - ph - 4 >= margin) {
    top = r.top - ph - 4;
  }
  top = Math.max(margin, Math.min(top, window.innerHeight - ph - margin));
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

// Unique ids per mounted menu popover (one element per id per document).
let menuPopSeq = 0;

// A top-layer dropdown: a trigger button plus a `popover` panel in the
// browser top layer, so no ancestor's overflow / transform / stacking context
// can clip it (the file menu sits in the bar's overflow:hidden left cluster).
// The caller fills `pop` and reads `trigger` to render the affordance.
interface PopoverMenu {
  root: HTMLElement;
  trigger: HTMLButtonElement;
  pop: HTMLElement;
  close(): void;
  destroy(): void;
}

function buildPopoverMenu(spec: {
  rootClass: string;
  triggerClass: string;
  label: string;
  align: 'start' | 'end';
  // Panel overrides. The menus keep the defaults (a `menu` element with
  // role="menu" and an aria-haspopup trigger); a plain panel (drive sync)
  // passes its own tag / class and `menuSemantics: false`.
  popTag?: 'menu' | 'div';
  popClass?: string;
  idPrefix?: string;
  menuSemantics?: boolean;
  // When set, engines without the native Popover API fall back to toggling
  // this class on the panel (the CSS defaults the panel to `display:none`)
  // plus a manual outside-click dismiss. Without it the native API is
  // required, matching the dashboard's MenuPopover (the hosted dialogs an
  // app opens are dashboard pages, so the platform floor is already set
  // there).
  fallbackOpenClass?: string;
}): PopoverMenu {
  const root = el('span', spec.rootClass);
  const trigger = el('button', spec.triggerClass);
  trigger.type = 'button';
  const menuSemantics = spec.menuSemantics ?? true;
  if (menuSemantics) trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-label', spec.label);
  const pop = el(spec.popTag ?? 'menu', spec.popClass ?? 'brass-ui b-pop');
  pop.id = `${spec.idPrefix ?? 'brass-menu-pop'}-${++menuPopSeq}`;
  pop.setAttribute('popover', 'auto');
  if (menuSemantics) pop.setAttribute('role', 'menu');
  root.append(trigger, pop);

  const popApi = pop as HTMLElement & {
    showPopover?: () => void;
    hidePopover?: () => void;
  };
  const fallbackClass = spec.fallbackOpenClass;
  const nativePopover =
    fallbackClass === undefined || typeof popApi.showPopover === 'function';

  const reposition = (): void => positionPopover(trigger, pop, spec.align);
  const inFallbackClass = (): boolean =>
    fallbackClass !== undefined && pop.classList.contains(fallbackClass);
  const isOpen = (): boolean => {
    if (!nativePopover) return inFallbackClass();
    try {
      return pop.matches(':popover-open');
    } catch {
      return inFallbackClass();
    }
  };
  function onOutside(e: MouseEvent): void {
    if (!root.contains(e.target as Node)) close();
  }
  function open(): void {
    if (isOpen()) return;
    if (nativePopover) popApi.showPopover?.();
    else if (fallbackClass !== undefined) {
      pop.classList.add(fallbackClass);
      document.addEventListener('click', onOutside, true);
    }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
  }
  // Guarded: hidePopover() throws InvalidStateError on a popover that is
  // not showing (incl. a disconnected element on destroy).
  function close(): void {
    if (!isOpen()) return;
    if (nativePopover) popApi.hidePopover?.();
    else if (fallbackClass !== undefined) {
      pop.classList.remove(fallbackClass);
      document.removeEventListener('click', onOutside, true);
    }
    window.removeEventListener('resize', reposition);
    window.removeEventListener('scroll', reposition, true);
  }
  // The trigger is wired as the popover's invoker. The UA exempts an
  // invoker from light-dismiss, so a click on the trigger of an OPEN
  // popover closes it; a manual onclick toggle instead races light-dismiss
  // (pointerdown hides the popover, then click sees it closed and reopens
  // it), leaving a menu that can't be closed from its own trigger. The
  // manual toggle exists only on the no-native-Popover fallback path.
  if (nativePopover) trigger.setAttribute('popovertarget', pop.id);
  else trigger.onclick = () => (isOpen() ? close() : open());
  // The UA drives native open/close (invoker click, outside tap, Escape)
  // without routing through open()/close(), so position on every open and
  // detach the reposition listeners on close. (No-op on the fallback path,
  // which has no native toggle event.)
  const onToggle = (event: Event): void => {
    const state = (event as Event & { newState?: string }).newState;
    if (state === 'open') {
      reposition();
      window.addEventListener('resize', reposition);
      window.addEventListener('scroll', reposition, true);
    } else if (state === 'closed') {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    }
  };
  pop.addEventListener('toggle', onToggle);

  return {
    root,
    trigger,
    pop,
    close,
    destroy(): void {
      close();
      pop.removeEventListener('toggle', onToggle);
      document.removeEventListener('click', onOutside, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    },
  };
}

// Internal piece: builds its own DOM (`root`) and manages its subscriptions.
// The caller places `root` (standalone fills a container; the bar nests it).
interface PieceInternal extends MountedPiece {
  readonly root: HTMLElement;
}

// --- Pieces ----------------------------------------------------------------

function buildFileMenu(deps: FileMenuDeps): PieceInternal {
  injectStyles(document);
  const menu = buildPopoverMenu({
    rootClass: 'brass-ui b-menu',
    triggerClass: 'b-burger',
    label: 'Menu',
    align: 'start',
  });
  menu.trigger.textContent = '☰';

  const render = (): void => {
    const rows: HTMLElement[] = [];
    let group: string | null = null;
    for (const c of deps.session.commands) {
      if (c.surface !== 'menu') continue;
      // A rule wherever the family changes: the entries that put a
      // different document on screen, then the ones about this document.
      if (group !== null && c.group !== group) {
        const sep = el('hr', 'b-sep');
        sep.setAttribute('role', 'separator');
        rows.push(sep);
      }
      group = c.group;
      const b = renderCommandButton(c, false);
      b.onclick = () => {
        menu.close();
        void c.run();
      };
      rows.push(b);
    }
    menu.pop.replaceChildren(...rows);
  };
  render();
  const unsub = deps.session.subscribe(render);
  return {
    root: menu.root,
    destroy(): void {
      unsub();
      menu.destroy();
    },
  };
}

function buildDocumentTitle(deps: DocumentTitleDeps): PieceInternal {
  injectStyles(document);
  const root = el('div', 'brass-ui b-identity');
  const titleRow = el('div', 'b-titlerow');
  const title = el('button', 'b-title');
  title.type = 'button';
  // A chip qualifying the title with the non-default branch. Hidden on the
  // default branch, and dropped (not truncated) when the title row can't fit
  // it, so the document name keeps priority. Opens the branches dialog.
  const branch = el('button', 'b-branch');
  branch.type = 'button';
  branch.hidden = true;
  branch.onclick = () => void deps.session.run('branches');
  titleRow.append(title, branch);
  const loc = el('button', 'b-loc');
  loc.type = 'button';
  loc.hidden = true;
  root.append(titleRow, loc);

  // The document the location chip describes, held by INSTANCE. A branch
  // switch, and a re-open after the document moves, bind a new Document under
  // the same id, and a move is exactly the event that changes the location
  // label, so an id comparison would leave the chip naming the old project.
  let boundDoc: DocumentSession['document'] = null;
  // The non-default branch label (null on the default), read by `fitBranch`
  // so a resize re-evaluates the drop without a full re-render.
  let branchLabel: string | null = null;

  // Show the branch chip, then drop it if the title row can't fit it. Reading
  // `scrollWidth` forces a sync layout, so the overflow test reflects the
  // just-applied text.
  function fitBranch(): void {
    if (!branchLabel) {
      branch.hidden = true;
      return;
    }
    branch.hidden = false;
    if (titleRow.scrollWidth > titleRow.clientWidth) branch.hidden = true;
  }

  // The active doc's branch name when it is NOT the default, else null. Reads
  // the doc's internal branch state, so it settles once the branch list loads
  // (a `'branches'` subscribe tick re-renders the chip).
  function activeBranchLabel(): string | null {
    return deps.session.document?._currentBranchName() ?? null;
  }

  // Resolves the label for one document, named by the caller so the in-flight
  // fetch is attributed to the Document it was started for.
  async function refreshLocation(doc: DocumentSession['document']): Promise<void> {
    const docId = doc?.id ?? null;
    if (!docId) {
      loc.hidden = true;
      return;
    }
    try {
      const record = await deps.getDocument(docId);
      if (deps.session.document !== doc) return; // superseded
      // The server hands back an opaque location label (rendered verbatim);
      // the toolbar never composes it from project / org ids, so the
      // hierarchy above the document can evolve without a client change. A
      // null label is the loose (unfiled) state.
      if (record.location_label !== null) {
        loc.textContent = record.location_label;
        loc.className = 'b-loc filed';
        loc.title = 'Move or rename this document';
      } else {
        loc.textContent = 'Add to project';
        loc.className = 'b-loc loose';
        loc.title = 'File this document in a project';
      }
      loc.hidden = false;
    } catch {
      if (deps.session.document === doc) loc.hidden = true;
    }
  }

  function runManage(): void {
    void (async () => {
      await deps.session.run('manage');
      void refreshLocation(deps.session.document);
    })();
  }
  title.onclick = runManage;
  loc.onclick = runManage;

  const render = (): void => {
    const session = deps.session;
    const doc = session.document;
    // Three states, not two. A bound doc whose name has not resolved yet
    // (a fresh create the server just numbered, a create/open still settling)
    // and an open in flight (`status` 'loading', `document` still null) both
    // leave the name UNKNOWN: render nothing rather than assert "No document",
    // the same way the session reports 'unknown' auth as a neutral state
    // instead of flashing 'signed-out'. Only the genuine empty state (no doc,
    // not loading) reads "No document".
    const name = doc
      ? doc.name
      : session.status === 'loading'
        ? null
        : 'No document';
    if (name === null) {
      title.hidden = true;
    } else {
      title.hidden = false;
      title.textContent = name;
      title.disabled = !doc;
    }
    if (!doc) loc.hidden = true;
    branchLabel = activeBranchLabel();
    if (branchLabel) {
      branch.textContent = branchLabel;
      branch.title = `On branch "${branchLabel}"`;
    }
    fitBranch();
    // Re-resolve location only when the bound document changes.
    if (doc !== boundDoc) {
      boundDoc = doc;
      void refreshLocation(doc);
    }
  };
  render();
  const unsub = deps.session.subscribe(render);
  // Re-evaluate the branch-chip drop on width changes (resize, tools reflow).
  // Guarded for hosts without ResizeObserver.
  const ro =
    typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => fitBranch())
      : null;
  ro?.observe(titleRow);
  return {
    root,
    destroy(): void {
      unsub();
      ro?.disconnect();
    },
  };
}

function buildUndoRedo(deps: UndoRedoDeps): PieceInternal {
  injectStyles(document);
  const root = el('div', 'brass-ui b-undo-redo');
  const render = (): void => {
    root.replaceChildren(
      ...deps.session.commands
        .filter((c) => c.surface === 'toolbar')
        .map((c) => {
          const b = renderCommandButton(c, true);
          b.onclick = () => void c.run();
          return b;
        }),
    );
  };
  render();
  const unsub = deps.session.subscribe(render);
  return {
    root,
    destroy(): void {
      unsub();
    },
  };
}

function buildPresenceRoster(deps: PresenceRosterDeps): PieceInternal {
  injectStyles(document);
  const root = el('div', 'brass-ui b-roster');

  // The document whose presence client is subscribed, held by INSTANCE.
  // Presence is scoped to a (document, branch) pair, and a branch switch binds
  // a new Document under the SAME id, so an id comparison would keep the
  // roster subscribed to the branch the user just left and show the wrong
  // people as present on the one they are looking at.
  let boundDoc: DocumentSession['document'] = null;
  let presenceOff: (() => void) | null = null;

  const renderRoster = (participants: readonly PresenceParticipant[]): void => {
    root.replaceChildren(
      ...participants.map((p) => {
        const pip = el('span', 'b-pip');
        pip.style.background = p.color;
        const label = p.displayName ?? p.sub ?? '?';
        pip.title = label;
        const initial = label.slice(0, 1).toUpperCase() || '?';
        const url = p.avatarUrl?.trim() ?? '';
        if (url) {
          // The collaborator's avatar fills the pip; the coloured initial
          // stays the fallback, restored if the image fails to load (a
          // broken / expired URL shows the initial, not a broken-image
          // glyph). The pip keeps its per-sub colour as the image backdrop.
          const img = el('img', 'b-pip-img');
          img.alt = '';
          img.addEventListener('error', () => {
            pip.textContent = initial;
          });
          img.src = url;
          pip.appendChild(img);
        } else {
          pip.textContent = initial;
        }
        return pip;
      }),
    );
  };

  function bindPresence(): void {
    presenceOff?.();
    presenceOff = null;
    root.replaceChildren();
    const presence = deps.session.presence;
    if (!presence) return;
    renderRoster(presence.roster ?? []);
    const off = presence.on('change', renderRoster);
    presenceOff =
      typeof off === 'function' ? off : () => presence.off('change', renderRoster);
  }

  const render = (): void => {
    const doc = deps.session.document;
    if (doc !== boundDoc) {
      boundDoc = doc;
      bindPresence();
    }
  };
  render();
  const unsub = deps.session.subscribe(render);
  return {
    root,
    destroy(): void {
      unsub();
      presenceOff?.();
    },
  };
}

// A monochrome 16px stroke glyph (inherits `color` via `currentColor`). Built
// in the SVG namespace because `createElement('svg')` yields an HTML element
// that won't render.
function strokeIcon(...paths: string[]): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

function chainLinkIcon(): SVGSVGElement {
  return strokeIcon(
    'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71',
    'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.72-1.71',
  );
}

// How long the popover holds its "Publishing..." affordance after a push
// before giving up on the synced confirmation. Long enough to cover a normal
// drive webhook round-trip.
const PUBLISH_HOLD_MS = 30000;

// `value` when it is an absolute http(s) URL, else null. The drive-sync
// popover's "View in <drive>" link is the one place the toolbar puts a
// server-supplied string into an `href`, and an href runs whatever scheme it
// names: a `javascript:` URL executes in the app's own page on the click.
// A relative URL throws out of `new URL` and is refused with the rest, which
// is right here, since the link points at an external drive item.
function httpUrlOrNull(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
}

// The drive-sync indicator: a link icon (dim at rest, accent / danger with a
// dot when there is something to do) whose popover describes the state
// (server-authored copy, verbatim) and offers publish / resolve. The receiver
// half of `doc.pushToDrive` / `doc.resolveDrive`. Hidden only when the doc is
// not drive-linked, so a non-drive app mounts it harmlessly. A plain panel,
// not a menu, with the `.b-drive-open` class fallback for engines without
// the native Popover API.
function buildDriveSync(deps: DriveSyncDeps): PieceInternal {
  injectStyles(document);
  const menu = buildPopoverMenu({
    rootClass: 'brass-ui b-drive',
    triggerClass: 'b-drive-icon',
    label: 'Drive sync',
    align: 'start',
    popTag: 'div',
    popClass: 'brass-ui b-drive-pop',
    idPrefix: 'brass-drive-pop',
    menuSemantics: false,
    fallbackOpenClass: 'b-drive-open',
  });
  const { root, pop } = menu;
  root.hidden = true;
  const button = menu.trigger;
  button.append(chainLinkIcon());
  const dot = el('span', 'b-drive-dot');
  dot.setAttribute('aria-hidden', 'true');
  button.append(dot);

  // The document whose drive status is subscribed, held by INSTANCE. A branch
  // switch binds a new Document under the same id, and each carries its own
  // drive state, so an id comparison would leave the indicator describing the
  // document that was closed.
  let boundDoc: DocumentSession['document'] = null;
  let statusOff: (() => void) | null = null;
  let publishOff: (() => void) | null = null;

  // A publish runs on a server worker and reaches `synced` only after the
  // worker (and, on a file-roundtrip, the drive's importer) confirms. In that
  // gap the drive state still reads `ahead`, which would flash "unpublished
  // changes" / re-offer Publish. The server computes "a push is in flight"
  // once and exposes it as `driveStatus.publishing` (with the progress copy on
  // `detail`), so hold a steady "Publishing..." while it is true, regardless
  // of which surface started the push. `publishing` is only a short local hold
  // covering the gap between a click here and the first `publishing` frame
  // arriving; the two combine as `isPublishing` in `render`.
  let publishing = false;
  let publishError = false;
  let publishTimer: ReturnType<typeof setTimeout> | null = null;
  // Set on a click, cleared by the next publish-state frame. Between the two,
  // the held state describes the PREVIOUS attempt, and rendering it would
  // report the last failure over the publish just started.
  let publishStateStale = false;
  let currentStatus: DocumentDriveStatus | null = null;
  const clearPublishing = (): void => {
    publishing = false;
    // The stale mark is cleared with the hold it belongs to. It is otherwise
    // cleared only by a publish-state frame, so a publish that draws none
    // would leave the panel reading the target's resting sentence for the
    // life of the document.
    publishStateStale = false;
    if (publishTimer !== null) {
      clearTimeout(publishTimer);
      publishTimer = null;
    }
  };

  // The panel for a document with no source item: the server's sentence about
  // where the file lands, and the publish that puts it there. The first
  // publish creates the artifact and makes the document its mirror, at which
  // point the drive status arrives and the mirror panel above replaces this
  // one.
  const renderPublishOffer = (target: DrivePublishTarget): void => {
    root.hidden = false;
    // A document the drive has never received is as far out of sync as one
    // whose edits have not been published, so the icon carries the same
    // attention an `ahead` document's does. What separates them is what the
    // panel offers, not how much the reader is told to look.
    root.classList.add('has-changes');
    root.classList.remove('is-broken');
    const state = publishStateStale ? null : (boundDoc?._publishState ?? null);
    const inFlight =
      publishing || state?.publishing === true || target.publishing;
    button.title = inFlight
      ? 'Publishing...'
      : state?.failed
        ? `Publish to ${target.driveName} failed`
        : `Publish to ${target.driveName}`;

    const failed =
      !inFlight && (state?.failed === true || target.publishFailed === true);

    const rows: HTMLElement[] = [];
    // One line, server-authored either way: the worker's phase copy while it
    // runs, its account of the failure when it stopped, and the resting
    // sentence otherwise. Marked as a problem when it is one, since nothing
    // else in this panel distinguishes a document whose publish failed from
    // one that has simply never published.
    const p = el('p', failed ? 'b-drive-unreadable' : 'b-drive-detail');
    p.textContent = inFlight
      ? (state?.publishing === true ? (state.detail ?? 'Publishing...') : 'Publishing...')
      : (state?.detail ?? target.detail);
    rows.push(p);

    const pub = el('button');
    pub.type = 'button';
    pub.disabled = inFlight;
    pub.textContent = inFlight
      ? 'Publishing...'
      : publishError || failed
        ? `Publish to ${target.driveName}, retry`
        : `Publish to ${target.driveName}`;
    pub.onclick = () => {
      const doc = deps.session.document;
      if (!doc) return;
      publishError = false;
      publishing = true;
      publishStateStale = true;
      // The same safety net the mirror panel keeps: a publish that neither
      // errors nor lands leaves the panel offering the action again rather
      // than held forever.
      publishTimer = setTimeout(() => {
        clearPublishing();
        render(currentStatus);
      }, PUBLISH_HOLD_MS);
      render(currentStatus);
      void doc.pushToDrive().catch(() => {
        clearPublishing();
        publishError = true;
        render(currentStatus);
      });
    };
    rows.push(pub);
    pop.replaceChildren(...rows);
  };

  const render = (status: DocumentDriveStatus | null): void => {
    currentStatus = status;
    // A document that mirrors nothing can still have somewhere to go: its
    // project may be linked to a drive that takes it as a new file, which is
    // what an upload into a linked project sits waiting for. Offer that
    // publish here, so an app gets it by mounting this piece rather than by
    // building a surface of its own.
    if (status === null) {
      const target = boundDoc?._publishTarget ?? null;
      if (target === null) {
        root.hidden = true;
        menu.close();
        clearPublishing();
        root.classList.remove('has-changes', 'is-broken');
        pop.replaceChildren();
        return;
      }
      renderPublishOffer(target);
      return;
    }
    // The publish settles once the doc actually reaches synced; drop the
    // local hold (the server frame already has `publishing: false`).
    if (status.state === 'synced') {
      clearPublishing();
      publishError = false;
    }
    root.hidden = false;
    // Either a local click hold or the server's own `publishing` flag means a
    // push is in flight; both suppress the `ahead` affordance.
    const isPublishing = publishing || status.publishing;
    const driveName = status.driveName;
    const broken = status.broken;
    // The icon brightens (and the dot shows) only when there is something
    // to act on; a synced / unhydrated doc stays dim.
    const hasChanges =
      !broken &&
      (status.state === 'ahead' ||
        status.state === 'behind' ||
        status.state === 'diverged');
    root.classList.toggle('is-broken', broken);
    root.classList.toggle('has-changes', hasChanges);
    button.title =
      status.detail ??
      (status.state === 'synced'
        ? `In sync with ${driveName}`
        : `Linked to ${driveName}`);

    // Popover: a "view source" link (the drive name is the link label, so no
    // separate header), a one-line state description (server-authored where
    // there is one), then the commands. Rebuilt on every status change, so an
    // open popover updates live.
    const rows: HTMLElement[] = [];
    const itemUrl = status.itemUrl ? httpUrlOrNull(status.itemUrl) : null;
    if (itemUrl) {
      const head = el('div', 'b-drive-head');
      const link = el('a', 'b-drive-source');
      link.href = itemUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = `View in ${driveName}`;
      head.append(link);
      rows.push(head);
    }

    // While the server reports the push in flight, `detail` carries its
    // phase-by-phase copy (exporting, uploading, waiting on the source's
    // importer); render it verbatim so the popover tracks the worker. The
    // fixed line covers only the local click-hold gap before the first
    // `publishing` frame arrives, when `detail` still holds resting copy.
    const description = status.publishing
      ? (status.detail ?? 'Publishing changes...')
      : publishing
        ? 'Publishing changes...'
        : (status.detail ??
          (status.state === 'synced'
            ? `In sync with ${driveName}.`
            : (status.label ?? '')));
    if (description) {
      const p = el('p', 'b-drive-detail');
      p.textContent = description;
      rows.push(p);
    }

    // The drive could not read what the last publish delivered. Shown in the
    // drive's own words, above the commands: the publish succeeded, so
    // nothing else in this panel says anything is wrong.
    if (status.sourceUnreadable) {
      const warn = el('p', 'b-drive-unreadable');
      warn.textContent = status.sourceUnreadable;
      rows.push(warn);
    }

    if (isPublishing) {
      // Held while the publish is in flight (a local click hold, or the doc's
      // pending work-status), until it reaches synced (see `isPublishing`).
      const pub = el('button');
      pub.type = 'button';
      pub.textContent = 'Publishing...';
      pub.disabled = true;
      rows.push(pub);
    } else if (status.canPush) {
      // `canPush` already encodes two-way + not broken + local edits + a
      // server-writable format, so this never offers a publish the server
      // would refuse.
      const pub = el('button');
      pub.type = 'button';
      pub.textContent = publishError ? 'Publish failed, retry' : 'Publish changes';
      pub.onclick = () => {
        const doc = deps.session.document;
        if (!doc) return;
        publishError = false;
        publishing = true;
        // Safety net: if the publish neither errors nor reaches synced (the
        // webhook never confirms), release the held state so the popover
        // recovers instead of hanging.
        publishTimer = setTimeout(() => {
          clearPublishing();
          render(currentStatus);
        }, PUBLISH_HOLD_MS);
        render(currentStatus);
        void doc.pushToDrive().catch(() => {
          clearPublishing();
          publishError = true;
          render(currentStatus);
        });
      };
      rows.push(pub);
    }
    // Resolve a divergence via the hosted take-source / keep-both surface. Not
    // on a broken link (the connection is gone, so re-import can't run).
    if (
      !isPublishing &&
      !broken &&
      (status.state === 'behind' || status.state === 'diverged')
    ) {
      const res = el('button');
      res.type = 'button';
      res.textContent = 'Resolve sync...';
      res.onclick = () => {
        // The hosted resolution surface is a modal, so close this popover.
        menu.close();
        void deps.session.document?.resolveDrive().catch(() => {});
      };
      rows.push(res);
    }
    pop.replaceChildren(...rows);
  };

  function bind(): void {
    statusOff?.();
    statusOff = null;
    publishOff?.();
    publishOff = null;
    const doc = deps.session.document;
    if (!doc) {
      render(null);
      return;
    }
    render(doc.driveStatus);
    // `driveStatus.publishing` carries the "push in flight" signal, so a push
    // started from any surface (the dashboard card, the app) flips it and the
    // indicator holds "Publishing..." without a local click.
    statusOff = doc.onDriveStatus(render);
    // The same signal for a document that mirrors nothing yet, which has no
    // drive status to carry it: its first publish is the one that creates the
    // artifact, and this is how its progress and its failure arrive.
    publishOff = doc._onPublishState(() => {
      publishStateStale = false;
      // A publish the server has finished with ends the local click hold:
      // holding "Publishing..." for the rest of it would report a push that
      // is over as one still running.
      if (!doc._publishState.publishing) clearPublishing();
      render(currentStatus);
    });
  }

  const onSession = (): void => {
    const doc = deps.session.document;
    if (doc !== boundDoc) {
      boundDoc = doc;
      bind();
    }
  };
  onSession();
  const unsub = deps.session.subscribe(onSession);
  return {
    root,
    destroy(): void {
      unsub();
      statusOff?.();
      publishOff?.();
      clearPublishing();
      menu.destroy();
    },
  };
}

function buildAccountMenu(deps: AccountMenuDeps): PieceInternal {
  injectStyles(document);
  const menu = buildPopoverMenu({
    rootClass: 'brass-ui b-menu b-account',
    triggerClass: 'b-avatar',
    label: 'Account',
    align: 'end',
  });
  // The menu opens on the identity it acts for: the avatar at reading size,
  // the display name, and the email under it. The name line drops out when the
  // user has none, leaving the email as the single identifying line.
  const head = el('div', 'b-account-head');
  const headFace = buildAvatarFace();
  const faceEl = el('span', 'b-account-face');
  faceEl.append(...headFace.nodes);
  const nameEl = el('div', 'b-account-name');
  const emailEl = el('div', 'b-email');
  const identity = el('div', 'b-account-id');
  identity.append(nameEl, emailEl);
  head.append(faceEl, identity);
  const headSep = el('hr', 'b-sep');
  headSep.setAttribute('role', 'separator');
  // Opens the dashboard in a new tab, so the user keeps the app open in the
  // current one. `/home` is the authenticated landing (resolves the active
  // org); the bare origin is the sign-in page.
  const dashboardLink = el('a');
  dashboardLink.append(
    strokeIcon(
      'M14 3h7v7',
      'M10 14 21 3',
      'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5',
    ),
    'Open Brass dashboard',
  );
  dashboardLink.href = `${deps.dashboardBaseUrl}/home`;
  dashboardLink.target = '_blank';
  dashboardLink.rel = 'noopener noreferrer';
  dashboardLink.onclick = () => menu.close();
  const signOutBtn = el('button');
  signOutBtn.append(
    strokeIcon('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4', 'm16 17 5-5-5-5', 'M21 12H9'),
    'Sign out',
  );
  signOutBtn.onclick = () => {
    menu.close();
    deps.signOut();
  };
  // Anonymous case: a guest opened the document through a public link with no
  // Brass session. The signed-in actions (email / dashboard / sign out) are
  // meaningless, so the menu offers a single "Sign in" that takes the top
  // window through the app's normal sign-in and returns to this URL.
  const signInBtn = el('button');
  signInBtn.append(
    strokeIcon('M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4', 'm10 17 5-5-5-5', 'M15 12H3'),
    'Sign in',
  );
  signInBtn.onclick = () => {
    menu.close();
    deps.signIn();
  };
  menu.pop.append(head, headSep, dashboardLink, signOutBtn, signInBtn);

  const triggerFace = buildAvatarFace();
  menu.trigger.append(...triggerFace.nodes);

  const renderUser = (user: BrassUser | null): void => {
    triggerFace.render(user);
    headFace.render(user);
    nameEl.textContent = user?.display_name ?? '';
    nameEl.hidden = !user?.display_name;
    emailEl.textContent = user ? (user.email ?? user.sub) : '';
    // The email ellipsizes to hold the menu's width, so the untruncated
    // address stays reachable on hover.
    emailEl.title = emailEl.textContent;
    // Swap the menu body between the signed-in actions and the guest's lone
    // "Sign in": a null user is an anonymous link holder.
    const signedIn = user !== null;
    head.hidden = !signedIn;
    headSep.hidden = !signedIn;
    emailEl.hidden = !signedIn;
    dashboardLink.hidden = !signedIn;
    signOutBtn.hidden = !signedIn;
    signInBtn.hidden = signedIn;
  };
  renderUser(deps.getUser());
  const unsub = deps.onUserChange(renderUser);
  return {
    root: menu.root,
    destroy(): void {
      unsub();
      menu.destroy();
    },
  };
}

// The historical-version preview bar. When the active doc is previewing an
// earlier version (a hosted `history`-initiated checkout: `doc.readOnly` is
// true and `doc.version` is set), the SDK mounts the platform-served
// `/embed/version-bar` inline as a strip and routes its intents (Prev / Next
// checkout, return-to-latest, browse, branch-from) to the doc's internal
// methods. Delivered as a server embed so the platform owns and grows the
// bar's features with no SDK or app change; the SDK stays a thin bridge.
// Version navigation itself is hosted; this piece owns the whole preview
// surface. Apps still gate their own edit controls on `doc.readOnly`.
function buildVersionPreview(deps: VersionPreviewDeps): PieceInternal {
  injectStyles(document);
  const root = el('div', 'brass-ui b-version');
  root.setAttribute('role', 'group');
  root.setAttribute('aria-label', 'Document version');

  let frame: VersionBarFrame | null = null;
  // Once a preview starts (a checkout), the bar owns a browsing session that
  // stays open, including after returning to the live head, until the user
  // explicitly closes it. So the bar is never dismissed as a side effect of
  // navigation (stepping to latest, returning to head). Reset when the user
  // closes it, when the active document changes, or when no doc is open.
  let browsing = false;
  let lastDocId: string | null = null;
  // The version the reader dismissed the bar at, when the document was left
  // holding one. A document that cannot return to its head (one pinned to a
  // version) stays on it, so without this the next render reads a non-null
  // `doc.version` and latches the bar the reader just dismissed straight back
  // on. A dismissal at the live head records nothing: there is no version
  // left to latch on, and the head is where the next browse-in-the-app
  // request arrives, so a record there would swallow it.
  let dismissedAt: number | undefined = undefined;

  const session = deps.session;
  const hideBar = (): void => {
    root.classList.remove('b-version-on');
    if (frame) {
      frame.destroy();
      frame = null;
    }
  };
  // A failed intent reaches the reader through the bar (which reverts to the
  // document's real state) and the developer through `Brass.onError`. Both
  // halves matter: the bar moves optimistically, so a swallowed failure is a
  // bar naming a version nothing is showing.
  const attempt = async (
    doc: BrassDocument,
    act: () => void | Promise<void>,
  ): Promise<void> => {
    try {
      await act();
    } catch (err) {
      doc._reportChromeError(err instanceof Error ? err : new Error(String(err)));
      throw err;
    }
  };
  const frameDeps: VersionBarDeps = {
    dashboardBaseUrl: deps.dashboardBaseUrl,
    ...(deps.hostedUiTheme ? { theme: deps.hostedUiTheme } : {}),
    // Read the live active document at call time: a bridge intent lands
    // async, so it must not close over a doc that may have been superseded.
    currentVersion: () => session.document?.version ?? null,
    checkoutVersion: async (version) => {
      const doc = session.document;
      if (!doc) return;
      await attempt(doc, () => doc._checkoutVersion(version));
    },
    returnToHead: async () => {
      // Return to the live head but keep the bar open (the browsing session
      // persists); the bar re-renders in its "at latest" state with a Close
      // button. Dismissal is the explicit `close` intent only.
      const doc = session.document;
      if (!doc) return;
      await attempt(doc, () => doc.returnToHead());
    },
    fork: (fromVersion, name) => {
      const doc = session.document;
      if (!doc) return;
      void attempt(doc, () => doc._forkFromVersion(fromVersion, name)).catch(() => {});
    },
    browse: () => {
      void session.run('history');
    },
    close: () => {
      // Explicit dismissal: end the browsing session and hide the bar
      // synchronously so the tap is instant. The document's own browsing
      // flag is cleared too, or the next render would latch the bar back on.
      const doc = session.document;
      browsing = false;
      dismissedAt = doc?.version ?? undefined;
      doc?._setVersionBrowsing(false);
      // Leaving the bar means leaving the preview: the bar is the only
      // surface that returns a document to its head, so a dismissal that
      // left it checked out would leave an app read-only with nothing to
      // clear it. A document pinned to its version has no head to return to
      // and keeps showing it; `dismissedAt` is what keeps the bar dismissed.
      // Once the return lands, the dismissal has nothing left to hold
      // against: the doc is live, and a LATER pick of the same version in
      // the history dialog is a fresh preview that must latch the bar (its
      // pick sets only `version`, so a stale `dismissedAt` equal to it would
      // otherwise leave the reader checked out, read-only, with no bar and
      // no exit).
      if (doc && doc.version !== null) {
        void attempt(doc, () => doc.returnToHead())
          .then(() => {
            if (session.document === doc) dismissedAt = undefined;
          })
          .catch(() => {});
      }
      hideBar();
    },
  };

  const render = (): void => {
    const doc = session.document;
    const docId = doc?.id ?? null;
    // A new active document (or none) ends any prior browsing session. Keyed
    // on the id rather than the Document instance because a checkout keeps the
    // instance and only moves its `version`, so the bar follows the document
    // the user is stepping through rather than closing under them.
    if (docId !== lastDocId) {
      lastDocId = docId;
      browsing = false;
      dismissedAt = undefined;
    }
    // A live checkout (`doc.version !== null`) starts / keeps the browsing
    // session. Other read-only states (a view-only share link, a still-loading
    // doc) are not this bar's concern, and `doc.id` is null only on the offline
    // / test path the embed can't serve.
    // `versionBrowsing` is set by the reader asking for this surface, and the
    // close cleared it, so it names a fresh request whatever version the
    // document is on and outranks the dismissal.
    if (
      doc != null &&
      docId !== null &&
      (doc.version !== null || doc.versionBrowsing) &&
      (doc.versionBrowsing || doc.version !== dismissedAt)
    ) {
      browsing = true;
      dismissedAt = undefined;
      // Mirror the open bar onto the document, which is what makes it
      // read-only for as long as the bar is up. A preview entered by picking
      // a version sets only `version`, so without this the reader who then
      // returns to latest keeps the bar and gets the document back, which is
      // the pair the flag exists to keep together.
      doc._setVersionBrowsing(true);
    }
    // The bar stays open for the whole session, including at the live head
    // (`doc.version === null`, browsing still true), until `close`.
    if (doc != null && docId !== null && browsing) {
      root.classList.add('b-version-on');
      if (!frame) frame = createVersionBarFrame(root, frameDeps);
      frame.update({
        docId,
        branch: doc.branchId ?? undefined,
        version: doc.version,
        branchName: doc._currentBranchName() ?? undefined,
        pinned: doc._isVersionPinned,
      });
    } else {
      hideBar();
    }
  };
  render();
  const unsub = session.subscribe(render);
  return {
    root,
    destroy(): void {
      unsub();
      frame?.destroy();
      frame = null;
    },
  };
}

// --- Standalone piece mounts -----------------------------------------------

function mountPiece(
  container: HTMLElement,
  piece: PieceInternal,
): MountedPiece {
  container.replaceChildren(piece.root);
  return {
    destroy(): void {
      piece.destroy();
      container.replaceChildren();
    },
  };
}

// The hamburger file menu (the `session.commands` menu-surface), mounted
// standalone into the app's own header.
export function createFileMenu(
  container: HTMLElement,
  deps: FileMenuDeps,
): MountedPiece {
  return mountPiece(container, buildFileMenu(deps));
}

// The document title plus a location chip; both open the hosted location
// editor (rename / move / file).
export function createDocumentTitle(
  container: HTMLElement,
  deps: DocumentTitleDeps,
): MountedPiece {
  return mountPiece(container, buildDocumentTitle(deps));
}

// The toolbar-surface commands (undo / redo) as prominent buttons.
export function createUndoRedo(
  container: HTMLElement,
  deps: UndoRedoDeps,
): MountedPiece {
  return mountPiece(container, buildUndoRedo(deps));
}

// The presence roster (coloured initials of who's on the active doc).
// Receiver half only; the app still publishes its own state.
export function createPresenceRoster(
  container: HTMLElement,
  deps: PresenceRosterDeps,
): MountedPiece {
  return mountPiece(container, buildPresenceRoster(deps));
}

// The drive-sync indicator (tracking state + Publish / Resolve). Renders
// nothing until a drive-linked doc drifts from its source, so a non-drive app
// mounts it harmlessly.
export function createDriveSync(
  container: HTMLElement,
  deps: DriveSyncDeps,
): MountedPiece {
  return mountPiece(container, buildDriveSync(deps));
}

// The account avatar menu (email + sign out).
export function createAccountMenu(
  container: HTMLElement,
  deps: AccountMenuDeps,
): MountedPiece {
  return mountPiece(container, buildAccountMenu(deps));
}

// The historical-version preview banner (return-to-live during a hosted
// `history` preview). Renders nothing until the active doc is previewing an
// earlier version, so an app mounts it harmlessly. The full toolbar and the
// bare header shell both include it, so this standalone mount is only for an
// app that builds fully custom chrome and wants the correct preview affordance.
export function createVersionPreview(
  container: HTMLElement,
  deps: VersionPreviewDeps,
): MountedPiece {
  return mountPiece(container, buildVersionPreview(deps));
}

// --- The shared bar shell --------------------------------------------------

// The responsive header layout, shared by `createSessionToolbar` and the
// slot-only `createSessionHeader`. Three clusters in one wrapping flex row:
// `start` ellipsizes (never wraps), `end` pins to row 1 top-right (never
// wraps), `tools` drops to its own row on mobile. The avatar lives in `end`,
// so this is the one place that guarantees it stays top-right.
interface BarShell {
  bar: HTMLElement;
  start: HTMLElement;
  tools: HTMLElement;
  end: HTMLElement;
  destroy(): void;
}

function buildBarShell(): BarShell {
  injectStyles(document);
  const bar = el('header', 'brass-bar brass-ui');
  const start = el('div', 'b-left');
  const tools = el('div', 'b-tools');
  const end = el('div', 'b-right');
  bar.append(start, tools, end);

  // Hide the tools strip when it holds no visible content: on mobile it wraps
  // to its own row, and an empty strip would still reserve that row plus the
  // row-gap, leaving asymmetric padding. "Empty" = every child is blank (no
  // text, no element children), so an empty save-indicator span or a
  // command-less undo/redo piece both count.
  function updateToolsVisibility(): void {
    const allBlank = Array.from(tools.children).every(
      (c) => (c.textContent ?? '').trim() === '' && c.childElementCount === 0,
    );
    tools.style.display = allBlank ? 'none' : '';
  }
  // The app (and the undo/redo subscription) mutates `tools` after mount, so
  // re-evaluate visibility on any change.
  const toolsObserver = new MutationObserver(() => updateToolsVisibility());
  toolsObserver.observe(tools, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  updateToolsVisibility();

  return {
    bar,
    start,
    tools,
    end,
    destroy(): void {
      toolsObserver.disconnect();
    },
  };
}

// --- The composed bar ------------------------------------------------------

export function createSessionToolbar(
  container: HTMLElement,
  deps: SessionToolbarDeps,
  options: SessionToolbarOptions = {},
): SessionToolbarHandle {
  const showPresence = options.presence !== false;
  const showAccount = options.account !== false;
  const showDrive = options.drive !== false;
  const shell = buildBarShell();

  // Left cluster: file menu + title/location identity + the drive-sync
  // indicator (by the title, where storage provenance belongs).
  const fileMenu = buildFileMenu(deps);
  const titlePiece = buildDocumentTitle(deps);
  shell.start.append(fileMenu.root, titlePiece.root);
  const pieces: PieceInternal[] = [fileMenu, titlePiece];
  if (showDrive) {
    const drivePiece = buildDriveSync(deps);
    shell.start.append(drivePiece.root);
    pieces.push(drivePiece);
  }

  // Middle: SDK toolbar-surface commands (undo/redo) + the app's slot.
  const undoRedo = buildUndoRedo(deps);
  shell.tools.append(undoRedo.root);
  pieces.push(undoRedo);

  // Right cluster: presence roster + account menu.
  if (showPresence) {
    const rosterPiece = buildPresenceRoster(deps);
    shell.end.append(rosterPiece.root);
    pieces.push(rosterPiece);
  }
  if (showAccount) {
    const accountPiece = buildAccountMenu(deps);
    shell.end.append(accountPiece.root);
    pieces.push(accountPiece);
  }

  // The historical-version preview bar sits below the bar as a full-width
  // strip: mounting the toolbar is all an app does to get correct version-
  // preview UX, so it never hand-rolls one.
  const versionPiece = buildVersionPreview(deps);
  pieces.push(versionPiece);
  container.replaceChildren(shell.bar, versionPiece.root);

  return {
    tools: shell.tools,
    destroy(): void {
      for (const p of pieces) p.destroy();
      shell.destroy();
      container.replaceChildren();
    },
  };
}

// The bare header shell for an app that builds its own header but wants the
// proven layout. Mount pieces (and your own content) into the returned
// `start` / `tools` / `end` slots; the avatar in `end` stays top-right and
// never wraps when `tools` does.
export function createSessionHeader(
  container: HTMLElement,
  deps?: VersionPreviewDeps,
): SessionHeaderHandle {
  const shell = buildBarShell();
  // A header shell built with session access includes the historical-version
  // preview bar below the bar, so a composable-chrome app gets the same
  // correct preview UX the full toolbar does without a separate mount.
  const versionPiece = deps ? buildVersionPreview(deps) : null;
  container.replaceChildren(
    shell.bar,
    ...(versionPiece ? [versionPiece.root] : []),
  );
  return {
    start: shell.start,
    tools: shell.tools,
    end: shell.end,
    destroy(): void {
      versionPiece?.destroy();
      shell.destroy();
      container.replaceChildren();
    },
  };
}
