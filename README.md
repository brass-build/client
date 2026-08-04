# @brass-build/client

Client SDK for [Brass](https://brass.build), a platform for building
and distributing enterprise-ready software. Brass closes the gap
between prototypes and production by ensuring that arbitrary, often
agent-coded software meets expectations for security, scalability,
robustness, and capability. Applications built on Brass inherit
foundational capabilities such as authentication, access control, and a
durable, collaborative data layer rather than reimplementing them.

Brass is fundamentally unopinionated, supporting any product
manifestation, data model, or sibling technologies. However, it is
particularly well-suited for software in the Architecture, Engineering,
and Construction (AEC) space, given its support for collaboration on
large geometric models and out-of-the-box integration into popular AEC
products.

```sh
npm install @brass-build/client
```

## Contents

- [Quickstart](#quickstart)
- [Setup](#setup)
- [Rendering auth state](#rendering-auth-state)
- [Default UI](#default-ui)
- [Document lifecycle](#document-lifecycle)
- [Editing documents](#editing-documents)
- [Presence](#presence-live-cursors-and-whos-here)
- [Streams](#streams-partitioning-large-documents)
- [Imported files](#imported-files)
- [Reference](#reference)
- [Guides](#guides)

## Quickstart

`@brass-build/client` turns a document into a live, multi-user,
persistent workspace. Your app supplies the UI; Brass supplies sign-in,
the file toolbar, and one subscribe-render-mutate loop per open
document. A working app is mostly your own rendering and event handling
wrapped around a handful of Brass calls.

**Describe it to a coding agent.** An app's dashboard page shows a
ready-to-paste prompt with its id already filled in. Paste it into
Claude, Cursor, or another assistant; the assistant reads this README
and [`AGENTS.md`](./AGENTS.md), then wires, verifies, and ships the
integration. The prompt is one line naming what you want and the SDK:

```
Build a shared checklist on @brass-build/client (NPM).
```

**Or wire it by hand.** The Brass surface of an app is small:

```ts
import { Brass } from '@brass-build/client';
import type { BrassUser, Document } from '@brass-build/client';

// Register listeners before init so validation failures reach onError.
Brass.onError((err) => console.error('[Brass]', err.message));

// Swap your two shells as auth settles. Both start hidden, so nothing
// paints before the first onUserChange fire.
Brass.onUserChange((user: BrassUser | null) => {
  document.getElementById('signed-out')!.hidden = !!user;
  document.getElementById('signed-in')!.hidden = !user;
});
document.getElementById('sign-in')!.onclick = () => Brass.signIn();

// The whole file menu in one call: document title, undo / redo,
// account menu, presence roster.
Brass.mountToolbar(document.getElementById('app-bar')!);

// Attach your editor to each document the session opens. Compare the
// Document instance, never the id (a version preview reuses the id).
let bound: Document | null = null;
Brass.session.subscribe((session) => {
  if (session.document !== bound) {
    bound = session.document;
    if (bound) bindEditor(bound);   // see Editing documents
  }
});

await Brass.init('brass_app_...');
```

`bindEditor` is your code: take a handle for the data you render
(`doc.orderedMap('items', 'item_order')` for a checklist), `subscribe`
to paint your list, and call `.mutate` from a click. The rendering,
styling, and event handling around it are ordinary app code.
[Document lifecycle](#document-lifecycle) and
[Editing documents](#editing-documents) show the loop in full.

Set up your bundler for the SDK's WebAssembly module
([Bundler setup](#bundler-setup)), then build and publish:

```sh
npm run build
npx @brass-build/cli login          # opens your browser to sign in
npx @brass-build/cli publish ./dist
```

The first publish creates the app, hosts it at
`https://<slug>.onbrass.app`, and writes its id to `.brass/project.json`
(the `brass_app_...` above). Your users sign in at that URL.

## Setup

To take the [quickstart](#quickstart) from source to a
signed-in, hosted app:

1. **Set up the bundler.** The SDK ships a WebAssembly module, and your
   bundler needs to know how to load it; see
   [Bundler setup](#bundler-setup).
2. **Ship it.** `npx @brass-build/cli publish ./dist` creates the app,
   hosts it, and returns a URL your users sign in at. A hosted bundle
   needs no app id; it inherits one from its serving origin. See
   [Ship it](#ship-it).
3. **Local dev and self-hosting need an app id.** Pass it to
   `Brass.init('brass_app_...')`. The first publish writes the id to
   `.brass/project.json`, or copy it from the app's dashboard page. A
   new app already allows sign-in from `localhost` / `127.0.0.1` on any
   port with no allowlist step; add a self-hosted origin on the app's
   detail page.

**CSP.** If (and only if) your app sends a `Content-Security-Policy`,
extend it: `script-src` needs `'wasm-unsafe-eval'` for the SDK's
WebAssembly, `frame-src` needs `https://app.brass.build` for the hosted
picker and share dialog, and `img-src` needs
`https://*.s3.<region>.amazonaws.com` if you render document thumbnails
(they are presigned S3 URLs).

### Bundler setup

`@brass-build/client` ships as ES modules, loaded by a bundler (Vite,
webpack, esbuild) or Node's ESM loader with `import`.

Without a WASM loader, `npm run build` fails with
`[vite:wasm-fallback] ... "ESM integration proposal for Wasm" is not
supported`. For Vite, install two plugins and add the SDK's own helper:

```sh
npm install --save-dev vite-plugin-wasm vite-plugin-top-level-await
```

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';
import { brassVite } from '@brass-build/client/vite';

export default defineConfig({
  plugins: [wasm(), topLevelAwait(), brassVite()],
  build: { target: 'es2022' },
});
```

`brassVite()` configures Vite's dep-prebundling step so the SDK's WASM
runtime loads on first `vite dev`. Vite 5/6 need
`vite-plugin-top-level-await`; Vite 8's rolldown bundler supports
top-level await natively. Webpack 5 needs `experiments.asyncWebAssembly: true` plus a
matching top-level-await plugin. The WASM bundle is ~3 MB uncompressed
(~600 KB gzipped).

### Init

The first argument to `Brass.init` is your `app_id` (a hosted bundle
omits it and inherits the id from its serving origin). The second is a
typed options object
(`BrassInitOptions`); the defaults are right for most apps, so you
usually pass nothing:

| Init option | Default |
| ----------- | ------- |
| `hostedUiTheme` | `'light'` (also `'dark'`, `'auto'`) |
| `syncDocToUrl` | `true` (sync the active selection to the URL + browser history) |
| `docUrlParam` | `'doc'` (the query param for the active doc id) |
| `branchUrlParam` | `'branch'` (the query param for a non-default branch) |
| `syncDocToTitle` | `true` (set the page title to `Doc name · App name` while a document is open) |
| `openIncompatibleDocuments` | `false` (Brass refuses to open a document your schema cannot read, and asks the person whether to go ahead) |

`Brass.init` resolves after one auth round-trip. Register `onError`
and `onUserChange` BEFORE calling `init`, so that validation failures
fire through your listener instead of dying as unhandled rejections; a
bad `app_id` still resolves, with `Brass.user === null`.

### Ship it

Publishing deploys your built bundle to Brass hosting at
`https://<slug>.onbrass.app` (or whichever domain you've configured), a
content origin Brass serves and adds to the app's sign-in allowlist for
you. Run it with the `brass` CLI:

```sh
npm run build
npx @brass-build/cli publish ./dist
```

The first run creates the app, enables hosting, uploads the build, and
writes the app id to `.brass/project.json`. Commit that file so later
publishes and your teammates target the same app.

Run `brass login` once first to authenticate (it opens your browser),
or set `BRASS_SERVICE_TOKEN` in a pipeline. The CLI also pulls a
document's schema into your `brass-app.json`. See
[`@brass-build/cli`](https://www.npmjs.com/package/@brass-build/cli).

## Rendering auth state

Auth has **four** states: `Brass.authStatus` is
`'unknown' | 'signed-in' | 'signed-out' | 'guest'`, where `'unknown'`
is the bootstrap window before `init` settles. The distinction matters
because a page reload always passes through `'unknown'`, and during it
`Brass.user` is still `null` even for a signed-in user. Never gate a
sign-in CTA on `!Brass.user`: that flashes the sign-in screen at
signed-in users on every reload. Render the CTA only on
`'signed-out'`, and render your working surface for **both**
`'signed-in'` and `'guest'`.

`'guest'` is the "anyone with the link" case: someone opened a public
view link, so there is no signed-in user but `Brass.session` still
opens the shared document **read-only** for them (`Brass.isGuest` is
`true`). When the page URL carries the link token, the session boots
the read-only document automatically; render your working surface for
`'guest'` too (the document is read-only, so edits are already
disabled).

`Brass.onUserChange` is the single source for reacting to auth
changes. It fires once when `init` resolves (with the real user or
`null`), then on every sign-in and sign-out. A listener registered
before `init` does not fire on registration; one registered after
does.

The plain-DOM sample in the [quickstart](#quickstart) gets this
right with no extra code, because both shells start `hidden` and
nothing shows until the first `onUserChange`. A framework app (React, Vue, Svelte) paints its
initial state synchronously, before that first fire, so it renders the
three states explicitly:

```ts
// Vue
const authStatus = ref(Brass.authStatus);
Brass.onUserChange(() => { authStatus.value = Brass.authStatus; });
```

```html
<SplashOrNothing v-if="authStatus === 'unknown'" />
<SignInCard      v-else-if="authStatus === 'signed-out'" />
<AppShell        v-else /> <!-- signed-in or guest (read-only) -->
```

## Default UI

`Brass.mountToolbar(container)` fills a container with the full
document toolbar, wired to the session: creating, opening, renaming,
sharing, and deleting documents, undo / redo, an account menu, and a
presence roster. Grow beyond it into your own header only when you need
one, and even then compose
the standard pieces (below) rather than rebuilding them. The call
returns a `tools` slot where your app's own persistent controls (a mode
palette, a save indicator) sit alongside the standard pieces:

```ts
const bar = Brass.mountToolbar(document.getElementById('app-bar')!);
bar.tools.append(orbitButton, drawButton);
```

The widget renders its own full-width, mobile-responsive bar, so give
it a full-width block container and let it own that row. The common
shell is a column flex with the bar on top and the working surface
filling the rest:

```html
<div style="display:flex; flex-direction:column; height:100vh">
  <div id="app-bar"></div>           <!-- mountToolbar fills this -->
  <div id="stage" style="flex:1"></div>
</div>
```

**Mount it once when the user signs in, not when a document opens.**
New and Open live in its file menu, so the bar has to exist in the
"signed in, nothing open" state; otherwise a user who just signed in
has no way to open or create a document. It re-renders itself as
documents open, switch, and close. It takes options `{ presence?, account? }` (both
default to `true`), and the returned handle's `destroy()` removes it.

A multi-pane app that builds its own header can still take the
standard pieces (file menu, title, undo / redo, presence roster,
drive-sync badge, account menu) individually instead of
re-implementing them; see "Composable header pieces" in
[`docs/custom-chrome.md`](./docs/custom-chrome.md). Include the
drive-sync badge (`Brass.mountDriveSync(el)`): on a document linked to
a connected drive it carries the user's pull, publish, and reconcile
actions, and on any other document it renders nothing, so mount it
unconditionally.

## Document lifecycle

`Brass.session` tracks which document is open. It restores the URL's
selection on boot, opens and closes documents, keeps the URL, browser
history, and page title in step with the active document (so Back /
Forward and reload behave as expected), and exposes the file-menu
commands as data, which `mountToolbar` renders for you. Your app
consumes all of this through one subscription:

```ts
Brass.session.subscribe((session) => {
  renderStatus(session.status);
  if (session.document !== bound) {
    bound = session.document;
    if (bound) bindEditor(bound);
  }
});
```

`session.subscribe` fires on lifecycle changes (open, close, switch,
command state, sign-in / sign-out), and calls your callback with the
`DocumentSession` synchronously on registration. It does **not** fire
on document edits; those arrive through the document's own `subscribe`
(below).

`session.status` tells you which of six screens to render:

| `status`     | Meaning                                  | Render                               |
| ------------ | ---------------------------------------- | ------------------------------------ |
| `unknown`    | `init` not settled; auth not yet known.  | Nothing, or a splash.                |
| `signed-out` | No signed-in user.                       | The sign-in CTA.                     |
| `empty`      | Signed in, no document open.             | "No document open. Use New or Open." |
| `loading`    | An open / create is in flight.           | A spinner or progress bar (below).   |
| `ready`      | A document is open (`session.document`). | Your editor.                         |
| `error`      | A document couldn't be opened, or the open one was deleted.| `session.error.message` + your recovery actions (below) |

Gate edit affordances on `ready`: a canvas that accepts input in the
`empty` state lets the user produce work with nowhere to save it.

**When an open fails.** A link to a document that was deleted, or that
the user cannot access, fails the open and the session enters `error`.
Someone else deleting the document while the user is editing lands in
the same state, so one screen covers both. Render the platform's
message with your own recovery actions:

```ts
if (session.status === 'error') {
  showMessage(session.error.message); // render verbatim; don't write your own
  // ...alongside your app's own New / Open buttons.
}
```

Display `session.error.message` verbatim; the platform authors it,
like `session.loadingMessage` and `doc.status.message`. Supply the
recovery actions yourself (your New / Open buttons). Use
`session.error.status` for logging or your own handling. A failed open
from an already-open document is different: the session keeps the
document you were editing and the `open()` call rejects, so catch that
at the call site instead.

**Loading progress.** While `status === 'loading'`, the session
exposes `session.loadingMessage` (a ready-to-render string such as
`Downloading... 62%`; show it verbatim) and `session.loadingProgress`
(a `0..1` fraction when the size is known, or `null` for
indeterminate). The document binds only after its content downloads,
so the first `ready` render already has the real model to read
directly.

**Where new documents land.** The `new` command (and
`session.create()`) places the document for you: a sibling of the open
document, or a platform-chosen home from the empty state.
`session.create()` resolves `null` if the user cancels placement:

```ts
await Brass.session.create({ name: 'Scheme B' });
```

**Keyboard shortcuts** route through `session.run`, which drives the
same undo / redo commands the toolbar buttons use. `session.commands`
carries every command with its id, and
[`docs/custom-chrome.md`](./docs/custom-chrome.md) tables the built-in
set if you need to invoke one directly:

```ts
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey)) return;
  const key = e.key.toLowerCase();
  if (key === 'z' && !e.shiftKey) {
    e.preventDefault();
    void Brass.session.run('undo');
  } else if ((key === 'z' && e.shiftKey) || key === 'y') {
    e.preventDefault();
    void Brass.session.run('redo');
  }
});
```

Code that runs outside the render loop can await the bound document
with `await Brass.session.whenReady()`; it resolves with the same
instance as `session.document`, immediately if one is already bound,
and rejects if the open fails or the user signs out before one binds.

The hosted dialogs (`Brass.selectDocument()`, `Brass.shareDocument()`)
handle browsing, picking, and sharing existing documents; the
session's Open and Share commands invoke them for you.

## Editing documents

### Bind the editor to the document

When the session opens a document, attach your editor to it: take a
handle for each container you render, and subscribe. The subscription
in [Document lifecycle](#document-lifecycle) does this in `bindEditor`,
called whenever `s.document` changes:

```ts
function bindEditor(doc: Document): void {
  const walls = doc.map<Wall>('walls');
  // One subscribe line is the whole render loop; the first fire
  // carries the current state, so there is no separate initial render.
  const stop = walls.subscribe(() => renderWalls(walls.read()));
  doc.onGone(() => stop());
}
```

Compare the **`Document` instance**, never `document.id`. The session
hands you a fresh instance on every open, and a version preview is a
new instance with the same id, so an id comparison would skip the
rebind and strand your editor on the previous state.

### Read and mutate

The primary editing surface is a **typed container handle**:
`doc.map<T>(key)` returns a scoped reference to one root container,
and its `read`, `mutate`, and `subscribe` only see (and only pay for)
that container. A large document stays cheap because your editor
touches the slice it cares about instead of walking the whole
document.

```ts
type Wall = { type: 'wall'; x: number; z: number };

const walls = doc.map<Wall>('walls');

walls.mutate((m) => { m[id] = { type: 'wall', x: 0, z: 0 }; }); // add
walls.mutate((m) => { m[id].x = 42; });                          // field edit
walls.mutate((m) => { delete m[id]; });                          // remove

const all = walls.read();      // Record<string, Wall>
const one = walls.get(id);     // Wall | undefined
```

Handles are cached per key (`doc.map('walls') === doc.map('walls')`),
so they compare stable across renders. `doc.list<T>(key)` is the same
surface for a root list; its mutate draft is a plain array proxy, and
indexed access returns a live element, so find an index then edit it in
place:

```ts
doc.list<Col>('cols').mutate((l) => {
  const i = l.findIndex((c) => c.id === colId);
  l[i].name = name;            // or l[i] = { ...l[i], name }, or l.splice(i, 1)
});
```

For a keyed collection that has to **stay in a stable order** (a list
of notes, layers, or steps), use `doc.orderedMap<T>(mapKey, orderKey)`
rather than a plain map with an app-computed sort key. It binds the map
to a sibling order list and keeps them in lockstep: a new key appends in
insertion order and a delete prunes from the order, both in the same
commit as the map edit. There is no counter or index to derive a sort
key from, which is what makes a hand-rolled key wrong here (a count is
not stable across deletes, so a later entry can sort before an earlier
one). Read it in order with `ordered()` or `keys()`.

```ts
const notes = doc.orderedMap<Note>('notes', 'note_order');
notes.mutate((m) => { m[id] = { text: '' }; });   // appends to the order
notes.mutate((m) => { m[id].text = 'hi'; });       // field edit; order untouched
for (const { key, value } of notes.ordered()) renderRow(key, value);
```

A field edit leaves the order alone, so its `subscribe` fire carries
only `set` / `deleted`; a change that moves the order also carries
`change.order` (the live keys in order). Re-sequence your rows when
`change.order` is present and patch in place otherwise, so a field echo
never disturbs the row a user is editing.

The doc-wide `doc.mutate(fn)` remains as a simpler fallback for tiny
documents and one-liner integrations (a proxy over the default
`entities` root). It operates on the same state as the handles, so an
app can mix the two freely.

Two mutation rules:

- **A nested list read through a parent proxy is a detached
  snapshot**, so `m[id].tags.push(x)` does not persist. Assign a whole
  new array (`m[id].tags = [...m[id].tags, x]`), or take a handle for
  the list itself (`parent.list(key)`). Nested **maps** walked through
  the proxy are live; the snapshot rule applies to lists only.
- **Don't write `undefined`.** Mutations JSON-serialise, so
  `undefined` inside an array becomes `null` and `undefined` property
  values are dropped. Use `null`, length checks, or `'key' in obj`
  instead.

A document starts **empty**, and the user's first action is their
first undoable edit. Don't seed a baseline from the client: a faked
"initial state" write is an ordinary edit, which means Ctrl-Z can
delete it unexpectedly. Content the user asked for (their first add) is
safe to persist; auto-written content they didn't ask for is not.

### Subscribing

`handle.subscribe(cb)` is one channel for every change, whatever
produced it: your own edit, a remote peer's, an undo, a version
checkout. It fires once on registration with the whole container as
`change.set`, then on every change, and each fire costs O(changed)
regardless of document size. Because your own edits arrive here too,
you render from one place and never patch a second copy at the edit
site, where a field updates but a header showing the same value does
not.

```ts
const stop = walls.subscribe((change) => {
  for (const [id, wall] of change.set) reconcileWall(id, wall); // added or updated
  for (const id of change.deleted) removeWall(id);              // removed
});
```

**Reconcile, don't rebuild, and skip the focused input.** The input
the user is typing in already shows what they typed, and a peer's
conflicting value should resolve when they blur the field, not by
yanking the caret mid-keystroke.

In a declarative framework, your own edit echoes back through
`subscribe` and re-renders the field mid-keystroke. Don't bind an editable input's value to a reactive
expression derived from the document. Bind it to a **local edit
buffer** (`v-model` on a per-field ref, `useState`), write the buffer
through to the document on input, and copy the document's value back
into the buffer only for fields that are not focused.

**`subscribe` is deferred; `read` and `get` are not.** A fire lands on
a microtask after the commit, so for the instant between your own
`mutate` and its echo a value you cached from the previous fire is
stale. Rendering never notices, because the echo repaints right after,
but a **synchronous read-after-write** does: allocating the next id,
checking a new name against the current set, or otherwise writing and
then immediately reading the derived state. Read those from `read()` /
`get()`, which always reflect the edit you just made, rather than from
a projection you keep in sync only through `subscribe`. The failure
mode is a mirror that you write through `mutate` and read back
synchronously in the same turn: the read runs before the subscription
that would have updated the mirror, so it sees the pre-write picture.

A `list` handle has no per-key delta; its subscriber takes no
arguments and re-reads (`list.subscribe(() => render(list.read()))`).
An `orderedMap` fire also carries `change.order` (the live ids in
order) when the order moves. The optional second callback argument
`origin` (`{ source: 'local' | 'remote' | 'undo' | 'redo' |
'checkout' }`) exists for attribution, such as highlighting a peer's
edit; a plain render ignores it.

`doc.subscribe(cb)` is the catch-all for events not tied to one
container (saving-count ticks, branch-list changes). Use it for status
surfaces, and render the editor from handles rather than from a
`doc.subscribe(() => renderAll())` that redraws on every tick.

### Undo, checkpoints, and version history

The `undo` and `redo` commands in the session's command list are fully
wired: the toolbar renders them, and keyboard shortcuts reach them
through `session.run`. The undo stack is local-peer-scoped, so
`undo()` only reverts commits this client made and a collaborator's
edits stay untouched. Outside the session, call `doc.undo()` /
`doc.redo()` directly and read the enabled state via
`doc.subscribeUndoState(cb)`.

A **checkpoint** (`doc.createCheckpoint()`) is both the Ctrl-Z
boundary and a marker on the document's version-history timeline, so
checkpoint timing sets both granularities. Auto-seals fire 60 seconds after
each burst of local edits settles, which means an app that does
nothing still gets usable undo boundaries and a usable history pane.
Tune it to your app's shape:

| Your app shape                          | What to do                                       | Result                                     |
| --------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| Default / no opinion                    | Nothing.                                         | Auto-seal every 60s of idle.               |
| Drag / brush / tool-stroke (3D, canvas) | `void doc.createCheckpoint()` on `pointerup`.    | One drag = one Ctrl-Z.                     |
| Text editor / fast bursts               | `doc.setAutoCheckpointIntervalMs(2000)` at boot. | Each typing pause becomes a boundary.      |
| Explicit-only                           | `doc.setAutoCheckpointIntervalMs(0)`             | Only deliberate `createCheckpoint` calls.  |

`createCheckpoint()` can reject on a rate limit, and a missed seal is
harmless, so call it fire-and-forget.

The SDK renders version preview itself: while an earlier version is
showing, `mountToolbar` / `mountHeader` show the "viewing an earlier
version" banner and return-to-live control (mount `mountVersionPreview`
for a fully custom shell). You handle your own edit controls:
`doc.readOnly` flips `true` during a preview (and for a view-only share
link, and while a document is still loading), so gate your custom tools
on it, and `doc.mutate` throws while read-only.

### Reacting to deletes

`doc.onGone(cb)` fires once when the server says the document is no
longer available (someone deleted it through the share dialog, for
example). The session reacts on its own, returning to the empty state
on the user's own delete or the `error` state when someone else deletes
the open document, so this hook exists for your app's own cleanup:

```ts
doc.onGone((reason) => {
  showToast(`"${docName}" was ${reason}.`);
  teardownEditor();
});
```

### Thumbnails

For a canvas app, one `useCanvas` call gives every document a live
thumbnail on its dashboard card:

```ts
Brass.session.useCanvas(() => document.querySelector('canvas'));
```

The SDK debounces about a second after each local edit, screenshots
the canvas, downscales, and uploads. **WebGL canvases must set
`preserveDrawingBuffer: true`** (Three.js:
`new THREE.WebGLRenderer({ preserveDrawingBuffer: true })`); without
it the read-back is a blank PNG, and the SDK warns once if the flag is
missing. Non-canvas apps skip this entirely; a document without a
thumbnail shows a blank tile and still gets its version-history
timeline.

## Presence (live cursors and who's here)

`doc.presence` shows who else is in the document and what they are
doing: a roster of the other live participants plus a small per-user
`state` (cursor, camera, selection). It is non-null on any open
writable document, and it is fully ephemeral; nothing survives a
disconnect. `Brass.session.presence` is the same client for the
session's open document, so use whichever handle you have.

Presence requires publishing your own state and rendering everyone
else's. Publish it on every pointer, camera, or selection move
(throttling is internal, about 10 Hz, so call as often as you like),
and render theirs in the working surface. A roster of initials in the
header shows who is present, not where they are working.

```ts
canvas.addEventListener('pointermove', (e) => {
  const p = pointerToWorld(e); // your app's screen-to-world unproject
  Brass.session.presence?.set({ state: { cursor: { x: p.x, y: p.y, z: p.z } } });
});
```

`cursor` is a 3D point in document world space (meters, right-handed,
Z-up; a 2D app passes `z: 0`), and an entity or text editor publishes
`selection` instead. `Brass.mountToolbar` and
`Brass.mountPresenceRoster` render the header roster for you. To
render remote cursors, diff the roster by `connectionId` on the
`change` event; the full recipe, coordinate conventions, and types are
in [`docs/presence.md`](./docs/presence.md).

## Streams (partitioning large documents)

You can split a document into named streams, each an independently
loaded unit of its state. Opening a document costs only the
streams your app touches, so a large design partitioned by discipline
opens at the size of one discipline, not the whole building:

```ts
const hvac = await doc.stream('hvac'); // downloads + subscribes hvac only
const records = hvac.orderedMap('instances', 'instance_order');
records.mutate((m) => {
  m[id] = { type, params };
});
```

`Brass.openDocumentById(docId, { stream })` opens the document with that
stream as its own state, so an app that works in one part of a large
document downloads only that part; it defaults to `'default'`, the stream
every document has. `doc.getOrCreateStream(name)` opens the document's
stream of that name and makes it when the document does not hold it yet
(idempotent, and concurrent callers converge on one stream, so an app
reaches for the stream it expects on every open); `doc.stream(name)`
opens one the document already holds and rejects any other name, and
resolves the name the document was opened at back to the document itself;
`doc.listStreams()` lists them. Code that iterates stream names
therefore handles partitioned and unpartitioned documents with one path.
A stream costs one extra round trip, so add one when it carries real
content: partition by load unit (a discipline, a heavy layer), not by
concept.

A schema names the streams it expects under `streams`. An app that
follows references between records reads every stream the document holds
(`doc.listStreams()`). A document can hold streams your schema does not
name, and your app leaves those alone. Naming a stream is how records
you work with (clash findings, review notes, a cache) ride in the
document: they sync and version with it, and an exporter composes only
the streams it declares, so records in a stream it does not name stay
out of the exported file. See [`docs/streams.md`](./docs/streams.md) and
[`docs/schemas.md`](./docs/schemas.md).

## Imported files

Start from what your app will open: the file the app exists for,
whether it is your own or an example from a user. Add it to an
organization (the dashboard, or any app's hosted picker, brings a file
in) and read what the document it becomes holds; that document decides
the schema your app declares. Your app opens it the way every document
opens: through the session and the hosted picker.

A document imported from a file (an upload or a drive link) lands in
one of two shapes, and the document's own page tells you which:

- **It holds records under a schema.** An importer for the format
  already exists (an installed app provides it). Adopt the document's
  schema (below) and read and edit the records through the ordinary
  handle surface
  (`doc.orderedMap('instances', 'instance_order')`). Brass re-emits the
  original file on export and drive-push through an installed app that
  serialises the format. A large
  document may spread its records across several streams; if your app
  follows references between records, read every stream the document
  holds, see
  [streams](./docs/streams.md#reading-a-document-spread-across-streams).
- **It is the stored file, and no schema resolves.** Nothing imports
  the format yet, so your app is its first importer. Register both
  halves of the format at boot: the importer parses the stored file
  into records, the serializer reconstitutes the file from them.

  ```ts
  Brass.registerImporter(async (src, doc) => {
    const bytes = new Uint8Array(await (await fetch(src.url)).arrayBuffer());
    const records = doc.orderedMap('instances', 'instance_order');
    records.mutate((m) => {
      for (const r of parseMyFormat(bytes)) m[r.id] = { type: r.type, params: r.body };
    });
  });
  Brass.registerSerializer((doc) => serializeMyFormat(doc));
  ```

  Brass runs the importer when the file needs importing, and the
  records reach every open client through its normal subscription.
  Declare the `schema` of the records your importer writes in
  `brass-app.json`; importing publishes that schema and stamps it on
  the document, so the next app can adopt it like any imported
  document's. Declare the file match there too
  (`"accepts": [{ "extension": "gpx" }]`) so Brass offers your app when
  someone uploads one.

To make your app open documents of an existing file type, adopt that
type's schema rather than re-derive its record shape. Get a document of
the shape you target (upload a sample file to your organization, or
open a document another app produced), copy
its schema from the document's page in the dashboard (**Download
brass-app.json**, or `npx @brass-build/cli schema pull --doc <docId>`),
and keep it verbatim as `schema` in your `brass-app.json`. The schema's family folds
into your `opens`, so documents of that shape route to your app, and
building against the copied body keeps you compatible with the other
apps that edit them. The declared schema is what routes existing
documents to your app: the picker lists documents by matching your
declared schema (or `accepts`), so ship the manifest with your first
deploy.

Every app ships a capability manifest at `/.well-known/brass-app.json`
in its bundle root, next to `index.html`. It declares the schema your
app works with, the files it accepts, the format it exports, and the
icon the platform renders as your app's mark. The platform re-reads it
after each deploy, so publishing your bundle is what registers it, and
an app that does not serve one registers nothing.
[`docs/app-manifest.md`](./docs/app-manifest.md) covers where the file
goes, what each key does, and how to confirm your build carries it.

The record-store shape, the conversion recipe, and schemas are covered
in [`docs/imported-documents.md`](./docs/imported-documents.md) and
[`docs/schemas.md`](./docs/schemas.md).

## Reference

`Brass` is the top-level namespace your app calls; its members are
below. The package's TypeScript types document `Document` and the
container handles (your editor's autocomplete lists every member and
signature), and the examples above show them in use, so this reference
does not repeat them.

### `Brass`

| Member                                                       | Returns                                 |
| ------------------------------------------------------------ | --------------------------------------- |
| `Brass.init(appId, options?)`                                | `Promise<void>`                         |
| `Brass.signIn()`                                             | `void` (navigates page)                 |
| `Brass.signOut()`                                            | `void` (navigates page)                 |
| `Brass.user`                                                 | `BrassUser \| null`                     |
| `Brass.authStatus`                                           | `'unknown' \| 'signed-in' \| 'signed-out' \| 'guest'` |
| `Brass.isGuest`                                              | `boolean` (anonymous link viewer)       |
| `Brass.onUserChange(cb)`                                     | `() => void` (unsubscribe)              |
| `Brass.onError(cb)`                                          | `() => void` (unsubscribe)              |
| `Brass.getAccessToken()`                                     | `Promise<string \| null>`               |
| `Brass.session`                                              | `DocumentSession` (see above)           |
| `Brass.mountToolbar(el, options?)`                           | `SessionToolbarHandle` (`{ tools, destroy }`) |
| `Brass.createDocument(options?)`                             | `Promise<OpenedDocument>` (`session.create` drives this) |
| `Brass.openDocumentById(docId, options?)`                    | `Promise<OpenedDocument>` (the session's open / pick path drives this) |
| `Brass.selectDocument()`                                     | `Promise<SelectDocumentResult \| null>` (the pick; also render from the session, see `docs/hosted-ui-advanced.md`) |
| `Brass.shareDocument(docId)`                                 | `Promise<void>`                         |
| `Brass.registerImporter(fn)`                                 | `void` (see `docs/imported-documents.md`) |
| `Brass.registerSerializer(fn)`                               | `void` (see `docs/imported-documents.md`) |
| `Brass.documents`                                            | namespace getter (metadata read, thumbnails, branches for a known doc id) |

The composable header mounts (`mountHeader`, `mountFileMenu`,
`mountDocumentTitle`, `mountUndoRedo`, `mountPresenceRoster`,
`mountDriveSync`, `mountAccountMenu`, `mountVersionPreview`) live in
[`docs/custom-chrome.md`](./docs/custom-chrome.md).

`OpenedDocument = Document & { readonly id: string }`. Open / create
methods return `OpenedDocument`; type app-level variables as
`OpenedDocument` so `doc.id` stays non-null. `BrassUser` is
`{ sub: string; email?: string; display_name?: string; avatar_url?: string }`.

### Errors

Every call rejects with one error type, `BrassError`. HTTP calls carry
`.status: number`, and the hosted-UI launchers (`selectDocument`,
`shareDocument`, ...) carry `.code` (`'embed_error'`,
`'not_in_browser'`). A call made without a signed-in session rejects
synchronously with `.status === 401`.

## Guides

- [`AGENTS.md`](./AGENTS.md): instructions for AI coding agents, covering the review loop, the UX defaults a generated app should meet, and shipping it to a published URL.
- [`docs/app-manifest.md`](./docs/app-manifest.md): the `brass-app.json` capability manifest every app ships, where it goes in your bundle, and what each key declares.
- [`docs/imported-documents.md`](./docs/imported-documents.md): the record store an imported file becomes, `Brass.registerImporter`, `doc.sourceBlob()`, and `Brass.registerSerializer`.
- [`docs/schemas.md`](./docs/schemas.md): declaring a schema, creating a stream, what lets an app open a document, and what breaks that.
- [`docs/custom-chrome.md`](./docs/custom-chrome.md): composable header pieces, and rendering `session.commands` yourself for a fully custom shell.
- [`docs/presence.md`](./docs/presence.md): remote cursors, roster rendering, coordinate conventions, full types.
- [`docs/hosted-ui-advanced.md`](./docs/hosted-ui-advanced.md): the hosted launchers (`Brass.selectDocument`, `Brass.shareDocument`), their redirect behavior in browsers that block the iframe, theming, CSP.
