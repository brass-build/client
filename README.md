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
- [Streams](#streams-loading-a-document-in-parts)
- [Imported files](#imported-files)
- [Referencing other documents](#referencing-other-documents)
- [Calling an outside service](#calling-an-outside-service)
- [Reference](#reference)
- [Guides](#guides)

## Quickstart

The easiest way to use Brass is to tell a coding assistant to do it for
you. Paste a line like the one below into Claude, Cursor, or another
assistant. The assistant reads this README and
[`AGENTS.md`](./AGENTS.md), then wires, verifies, and ships the
integration.

```
Build a shared checklist on @brass-build/client (NPM).
```

**Or wire it by hand:**

```ts
import { Brass } from '@brass-build/client';
import type { Document } from '@brass-build/client';

// Register before init, so a bad app id reaches your handler.
Brass.onError((err) => console.error('[Brass]', err.message));

// Fires when init resolves, then on every sign-in and sign-out. Show
// your app unless `Brass.authStatus` is 'signed-out': someone opening a
// share link has no user and still gets the document, read-only.
Brass.onUserChange(renderAuthState);
signInButton.onclick = () => Brass.signIn();

// Document title, file menu, undo / redo, account menu, presence roster.
Brass.mountToolbar(appBar);

// Rebind your editor to whichever document the session opens. Compare
// the instance, not the id: a version preview reuses the id.
let bound: Document | null = null;
Brass.session.subscribe((session) => {
  if (session.document === bound) return;
  bound = session.document;
  if (bound) bindEditor(bound);   // see Editing documents
});

// Reported by your first `brass publish` (as `app_id` under --json), or
// on your app's page in the dashboard.
await Brass.init('brass_app_...');
```

`bindEditor` is your code: take a handle for the data you render
(`doc.orderedMap('items', 'item_order')` for a checklist), `subscribe`
to paint your list, and call `.mutate` from a click.
[Document lifecycle](#document-lifecycle) and
[Editing documents](#editing-documents) show the loop in full.

Then build and publish:

```sh
npm run build
npx @brass-build/cli login          # sign in
npx @brass-build/cli publish ./dist --name "My app"
```

The first publish creates the app, hosts it at
`https://<slug>.onbrass.app` where your users sign in, and reports the
app id (the `brass_app_...` above).

## Setup

To take the [quickstart](#quickstart) from source to a
signed-in, hosted app:

1. **Ship it.** `npx @brass-build/cli publish ./dist --name "My app"`
   creates the app, hosts it, and returns its sign-in URL. See
   [Ship it](#ship-it).
2. **Pass an app id unless Brass hosts your bundle.** A published bundle
   resolves its id from the slot it is served on, so it calls
   `Brass.init()` with no argument. Pass the id everywhere else, in local
   development and on your own origin: `Brass.init('brass_app_...')`.
   `brass publish --json` reports it as `app_id`, or copy it from your
   app's page in the dashboard.

   One bundle covers both origins, because the id argument accepts
   `undefined`. Pass whatever your build resolved to
   (`Brass.init(import.meta.env.VITE_BRASS_APP_ID)`) and Brass falls back
   to the serving slot. Set the variable for local development as well:
   `localhost` has no slot to fall back to, and an absent id fails init.
3. **Allow your development origin if needed.** When you create an app
   interactively via the CLI or dashboard, it allows sign-in from
   `localhost` and `127.0.0.1` on any port by default. If the app was
   created non-interactively using an automated service token (such as
   in CI), it only permits its deployed origin. In that case, add your local
   dev URL (such as `http://localhost:5173/*`) to the app's allowed origins
   in the dashboard before signing in locally.

**CSP.** If (and only if) your app sends a `Content-Security-Policy`,
extend it: `script-src` needs `'wasm-unsafe-eval'` for the SDK's
WebAssembly, `frame-src` needs `https://app.brass.build` for the hosted
picker and share dialog, and `img-src` needs
`https://*.s3.<region>.amazonaws.com` if you render document thumbnails
(they are presigned S3 URLs).

### Modules and assets

`@brass-build/client` ships as ES modules, loaded by a bundler (Vite,
webpack 5) or Node's ESM loader with `import`.

The SDK runs a WebAssembly engine, which your bundler emits as its own
asset of about 3 MB, an order of magnitude larger than your JavaScript.
Serve it as `application/wasm`: browsers compile it while it streams,
and fall back to a slower path when the content type is something else.

Off Brass hosting (on your own origin or a dev server),
`Brass.init('brass_app_...')` also requests
`/.well-known/brass-runtime.json`. Do not serve that file. Your server
answers with a 404, which the console logs in red, or a dev server answers
with its `index.html`. Either answer is fine, and the SDK carries on with
the app id you passed.

### Vite dev server

Vite pre-bundles your dependencies for its dev server, which copies this
package into `node_modules/.vite/deps/` without moving the engine's binary
alongside it. The request for the binary then resolves inside that
directory, finds nothing, and the dev server answers with `index.html`, so
the engine receives a page to compile and the app fails when it first
opens a document. Keep this package out of that step:

```js
// vite.config.js
export default {
  optimizeDeps: { exclude: ['@brass-build/client'] },
};
```

`vite build` emits the binary as an asset and needs nothing, so this
setting is only for the dev server.

### Init

The first argument to `Brass.init` is your `app_id` ([Setup](#setup)
covers when you need one). The second is a typed options object,
`BrassInitOptions`. Its defaults suit most apps:

| Init option | Default |
| ----------- | ------- |
| `hostedUiTheme` | `'light'` (also `'dark'`, `'auto'`) |
| `syncDocToUrl` | `true` (sync the active selection to the URL + browser history) |
| `docUrlParam` | `'doc'` (the query param for the active doc id) |
| `branchUrlParam` | `'branch'` (the query param for a non-default branch) |
| `syncDocToTitle` | `true` (set the page title to `Doc name · App name` while a document is open) |
| `open` | `{ readOnly: false }` (set `{ readOnly: true }` to open documents in read-only mode by default) |

`Brass.init` resolves once it knows who the user is, which takes one
auth round-trip for someone who has signed in to your app before and no
request at all for a first-time visitor. Register `onError` and
`onUserChange` BEFORE calling `init`, so that validation failures fire
through your listener instead of dying as unhandled rejections. A bad
`app_id` still resolves, with `Brass.user === null`.

### Ship it

Publishing deploys your built bundle to Brass hosting at
`https://<slug>.onbrass.app` (or whichever domain you've configured), a
content origin Brass serves and adds to the app's sign-in allowlist for
you. Run it with the `brass` CLI:

```sh
npm run build
npx @brass-build/cli publish ./dist --name "My app"
```

The first publish creates the app named by `--name`, enables hosting, uploads the build,
and writes the app id to `.brass/project.json`. Commit that file so
later publishes and your teammates target the same app.

Run `brass login` once first to authenticate. It opens your browser,
and on a machine without one it prints a URL and a short code you
approve from any device. In a pipeline, set `BRASS_SERVICE_TOKEN`
instead. The CLI also pulls a document's schema into your
`brass-app.json`. See
[`@brass-build/cli`](https://www.npmjs.com/package/@brass-build/cli).

## Rendering auth state

Auth has **four** states: `Brass.authStatus` is
`'unknown' | 'signed-in' | 'signed-out' | 'guest'`, where `'unknown'`
is the bootstrap window before `init` settles. A page reload always
passes through `'unknown'`, and during it `Brass.user` is still `null`
even for a signed-in user, so gating a sign-in CTA on `!Brass.user`
flashes the sign-in screen at signed-in users on every reload. Render
the CTA only on `'signed-out'`, and render your working surface for
**both** `'signed-in'` and `'guest'`.

`'guest'` means the page has a document open without a signed-in user:
someone opened an "anyone with the link" view link, which the session
opens **read-only**, or a visitor made a document without an account
(below), which is editable. `Brass.isGuest` is `true` in both cases.

`Brass.onUserChange(cb)` is the single source for reacting to auth
changes. It calls `cb` once when `init` resolves, and again whenever
`Brass.user` or `Brass.authStatus` changes. A listener registered before
`init` does not fire on registration. One registered after does.

The [quickstart](#quickstart) sample gates on `'signed-out'` for exactly
this reason. A framework app (React, Vue, Svelte) paints its initial
state synchronously, before the first `onUserChange` fire, so it renders
the three states explicitly:

```ts
// Vue
const authStatus = ref(Brass.authStatus);
Brass.onUserChange(() => { authStatus.value = Brass.authStatus; });
```

```html
<SplashOrNothing v-if="authStatus === 'unknown'" />
<SignInCard      v-else-if="authStatus === 'signed-out'" />
<AppShell        v-else /> <!-- signed-in or guest -->
```

### Try before signing in

A visitor who can try your app without an account sees it work on their own
file before deciding to sign up. What your app can offer
that visitor depends on what it needs from an account: a visitor belongs to
no organization, so they cannot pick files for `Brass.chooseInputs`, and your
app cannot call a service from its manifest on their behalf. The session's
New and Open commands work without an account, so give your signed-out screen
buttons that run them:

```ts
signInButton.onclick = () => Brass.signIn();
newButton.onclick = () => Brass.session.run('new');
uploadButton.onclick = () => Brass.session.run('open');
```

For visitors without an account, the `open` command triggers the browser's
native file picker to upload a local file directly, and its label in
`Brass.session.commands` changes from "Open" to "Upload". Render the
button label from that command in your `Brass.session.subscribe` callback
rather than hardcoding "Open":

```ts
Brass.session.subscribe((session) => {
  uploadButton.textContent =
    session.commands.find((c) => c.id === 'open')?.label ?? 'Open';
});
```

Always trigger `Brass.session.run('open')` directly from a
button click handler, because browsers only permit file dialogs to open in
response to a direct user action. The file dialog filters for the file types
supported by your app.

While the file uploads and imports, `Brass.session.status` reads
`'loading'` and `Brass.authStatus` still reads `'signed-out'`, so your
signed-out screen renders the loading state. When Brass refuses the file
or the document, `Brass.session.error` carries the reason.

A document created without an account saves and syncs like any other, and a
reload or return visit in the same browser reopens it. If you use
`Brass.mountToolbar()`, the toolbar displays an expiration notice
automatically. If your app builds custom chrome instead, check
`doc.expiresAt` (which contains a `Date` for temporary documents, and `null`
for persistent ones) and display the remaining time to the visitor.

Do not offer `Brass.chooseInputs` or `Brass.chooseInput` on a temporary
document, because passing the chosen references to `doc.dependsOn` throws
there. Only display
those controls when `Brass.authStatus === 'signed-in'`.
`doc.subscribeInputDocuments` works on a temporary document and reports no
inputs, so subscribe without checking the sign-in state.

To save a temporary document permanently to an account, prompt the visitor to
sign in using `Brass.signIn()` (or the sign-in button in
`Brass.mountToolbar()`). When a visitor signs in from the active document
page, Brass automatically transfers the temporary document into their workspace.

Because a temporary document cannot reference other files, a visitor who is
not signed in can do nothing in an app whose content comes from the files
people pick, or in one where every action calls a service. For such an app,
declare `"create": "signed-in"` and skip the rest of this section. An app that
uses a service for one feature can still offer the rest to a visitor.

To let visitors without an account use your app, declare it in your
[`brass-app.json`](./docs/app-manifest.md):

```json
{ "access": { "create": "anyone" } }
```

and publish your app with `--gate off` and `--visibility public`:

```sh
npx @brass-build/cli publish ./dist --gate off --visibility public
```

- `--gate off` allows visitors to load your application bundle before
  signing in (by default, Brass requires sign-in before loading the app).
- `"create": "anyone"` and `--visibility public` allow visitors without an
  account to create, upload and edit temporary documents.

A visitor who is not signed in can also open an organization's public links
in your app. To ask visitors to sign in before a public link opens, set
`"open": "signed-in"` under `access`.

## Default UI

`Brass.mountToolbar(container)` fills a container with the full
document toolbar, wired to the session: creating, opening, renaming,
sharing, and deleting documents, undo / redo, an account menu, and a
presence roster. The call returns a `tools` slot where your app's own
persistent controls (a mode palette, a save indicator) sit alongside
the standard pieces:

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

**Mount it once when the user signs in or becomes a guest, not when a
document opens.** New and Open live in its file menu, so the bar has to
exist before any document does. It re-renders itself as documents open,
switch, and close. It takes options `{ presence?, account?, drive? }` (all default to `true`), and
the returned handle's `destroy()` removes it.

A multi-pane app that builds its own header takes the standard pieces
(file menu, title, undo / redo, presence roster, drive-sync badge,
account menu) individually rather than re-implementing them. See
"Composable header pieces" in
[`docs/custom-chrome.md`](./docs/custom-chrome.md). Mount the
drive-sync badge (`Brass.mountDriveSync(el)`) unconditionally: it
carries the drive actions the open document has, the pull, publish, and
reconcile of a linked document, and the offer to publish one its
project's drive has not received yet.

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
`DocumentSession` synchronously on registration. Document edits arrive
through the document's own `subscribe` (below), not here.

`session.status` tells you which of six screens to render:

| `status`     | Meaning                                  | Render                               |
| ------------ | ---------------------------------------- | ------------------------------------ |
| `unknown`    | `init` not settled; auth not yet known.  | Nothing, or a splash.                |
| `signed-out` | No signed-in user.                       | The sign-in CTA (and Try without an account, if your app offers it). |
| `empty`      | Signed in, no document open.             | "No document open. Use New or Open." |
| `loading`    | An open / create is in flight.           | A spinner or progress bar (below).   |
| `ready`      | A document is open (`session.document`). | Your editor.                         |
| `error`      | A document couldn't be opened, the open one was deleted, or `init` was misconfigured (no app ID).| `session.error.message` + your recovery actions (below) |

Gate edit affordances on `ready`: a canvas that accepts input in the
`empty` state lets the user produce work with nowhere to save it.

**When an open fails.** The session enters `error` when it cannot open a
document: someone deleted it, the user cannot access it, or Brass could
not prepare it (a file it could not read). Someone else deleting the
document while the user is editing lands in the same state, so one
screen covers them all. Render the platform's message with your own
recovery actions:

```ts
if (session.error) {
  showMessage(session.error.message); // render verbatim; don't write your own
  // ...alongside your app's own New / Open buttons.
}
```

Use `session.error.status` for logging or your own handling. A failed
open from an already-open document is different: the session keeps the
document you were editing and the `open()` call rejects, so catch that
at the call site instead.

**Loading progress.** While `status === 'loading'`, the session
exposes `session.loadingMessage` (a ready-to-render string such as
`Downloading... 62%`; show it verbatim) and `session.loadingProgress`
(a `0..1` fraction when the size is known, or `null` for
indeterminate). The document binds only after its content downloads,
so the first `ready` render already has the real model to read
directly.

**Work on an open document.** Brass imports a new version of a file, syncs a
document to its drive, and does other work while the document is open.
`doc.status` carries that work and reads `null` when there is none;
`doc.onStatus(cb)` fires on every phase. Render `status.message`
verbatim and read `status.pending` for whether the work is still
running. The message is prose written for the user, so show it rather
than parsing it or inferring a phase from it. Both are readable
synchronously, so a fresh bind renders the current state without waiting
for a fire.

`doc.savingCount` is the count of this app's own writes that have not yet
been acknowledged, which is what a "Saving..." indicator reads. It ticks
through `doc.subscribe`, alongside the rest of what is not tied to one
container:

```ts
doc.subscribe(() => {
  saving.textContent = doc.savingCount > 0 ? `Saving ${doc.savingCount}...` : 'Saved';
});
```

**Where new documents land.** The `new` command (and
`session.create()`) places the document for you: a sibling of the open
document, or a platform-chosen home from the empty state.
`session.create()` resolves `null` if the user cancels placement:

```ts
await Brass.session.create({ name: 'Scheme B' });
```

`session.open()` with no arguments opens the hosted document picker and
opens the selected document in the session, resolving to `null` if the user
cancels. Use `session.create()` and `session.open()` when your app provides its
own buttons to create or open documents (such as empty-state prompts or
keyboard shortcuts). For signed-out visitors, these commands behave as
described in [Try before signing in](#try-before-signing-in).

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

Code that runs outside the render loop awaits the bound document with
`await Brass.session.whenReady()`. It resolves with the same instance
as `session.document`, immediately if one is already bound, and rejects
if the open fails or the user signs out before one binds.

The session's Open and Share commands show the hosted dialogs for you,
so browsing, picking, and sharing an existing document take no code.

**Opening in read-only mode.** By default, the session opens documents for
editing. If your app only views or inspects documents, set
`open: { readOnly: true }` in `Brass.init`:

```ts
await Brass.init(appId, { open: { readOnly: true } });
```

With this option, the session opens every document in read-only mode (whether
opened from the toolbar, a direct link, or a page reload).

To choose the mode for one document instead, pass `{ readOnly: true }` or
`{ readOnly: false }` to `session.open`, which overrides the init option for
that open.

Because `session.document` uses the `Document` type in both modes and
mutating a read-only document throws an error, check `doc.readOnly` before
displaying editing tools or enabling write actions.

If your app edits certain document families and only views others, initialize
in read-only mode, inspect the document's family, and upgrade when appropriate:

```ts
const doc = Brass.session.document;
if (doc?.readOnly && doc.id) {
  const { family } = await Brass.documents.get(doc.id);
  if (family && canEditFamily(family)) await doc.reopen(); // reopens with write access
}
```

`session.open(docId, options)` and `Brass.openDocumentById(docId, options)`
support these modes:

- **Default (editable):** Opens the document with full editing capabilities.
  `doc.readOnly` is `false` unless the user only has view access or the
  document is too large to edit (`doc.atCapacity === true`).
- **`{ readOnly: true }`:** Opens the document in read-only mode while still
  receiving other users' edits in real time. Returns a `ReadOnlyDocument`,
  whose type exposes no mutation methods.
- **`{ frozen: true }` (supported on `Brass.openDocumentById`):** Opens a
  static, read-only snapshot that disconnects from real-time sync. Use this for
  batch processing, reference data, or background tasks that only need to read
  data once without keeping an open WebSocket connection. Register
  `doc.onChanged(cb)` to detect when newer changes are available on the
  server, and call `await doc.reload()` to update the snapshot to the latest
  version.

**Handling open errors and pending imports.** When opening a document backed by
an imported file, the open waits for any in-progress conversion to finish. If the
import fails or the file format cannot be opened, the call rejects with a
`BrassError`. Display `error.message` in your error UI rather than attempting
to model the import lifecycle. If `subscribeInputDocuments` is watching the file,
it will invoke your callback once the file becomes openable.

**Switching modes with `reopen()`.** Call `await doc.reopen(options)` to switch
an open document between editable and read-only modes:

```ts
// Upgrade a read-only document to editable
await doc.reopen();

// Switch to read-only
await doc.reopen({ readOnly: true });
```

Brass flushes any unsaved changes, closes the previous instance, and passes the
new document instance to `session.subscribe`. Reopening for editing rejects with
a 403 `BrassError` if the user only has view access.

**Closing documents.** Call `doc.close()` when your app is finished with a
document opened via `Brass.openDocumentById()`:

```ts
const doc = await Brass.openDocumentById(id, { frozen: true });
try {
  for (const [key, value] of doc.map('elements').entries()) {
    processElement(key, value);
  }
} finally {
  doc.close();
}
```

### Large imported files

If your application only views or inspects documents, open them in read-only mode
(`{ readOnly: true }` or `Brass.init(appId, { open: { readOnly: true } })`).
Read-only and frozen modes load significantly faster and require far less bandwidth
than editable sessions. Unchanged documents can reopen directly from the local
cache without downloading again.

When `doc.atCapacity` is `true`, the document exceeds the maximum size supported
for collaborative editing. Disable editing tools and bulk operations, and display
`doc.status.message` to inform the user.

## Editing documents

### Bind the editor to the document

When the session opens a document, attach your editor to it: take a
handle for each container you render, and subscribe. The subscription
in [Document lifecycle](#document-lifecycle) does this in `bindEditor`,
called whenever `s.document` changes:

```ts
import type { Document } from '@brass-build/client';

function bindEditor(doc: Document): void {
  const walls = doc.map<Wall>('walls');
  // One subscribe block is the whole render loop; the first fire
  // carries the current state, so there is no separate initial render.
  const stop = walls.subscribe((change) => {
    for (const [id, wall] of change.set) reconcileWall(id, wall);
    for (const id of change.deleted) removeWall(id);
  });
  doc.onGone(() => stop());
}
```

Compare the **`Document` instance**, never `document.id`. The session
provides a fresh instance on every open, and a version preview is a
new instance with the same id, so an id comparison would skip the
rebind and strand your editor on the previous state. Brass also
swaps in a fresh copy of the document when an import finishes or a
just-imported document becomes editable, passing it to `session.subscribe`
once its content is in place, so keep the current view on screen until then.

### Read and mutate

The primary editing surface is a **typed container handle**:
`doc.map<T>(key)` returns a scoped reference to one root container,
and its `subscribe`, `mutate`, and `get` only see (and only pay for)
that container. A large document stays cheap because your editor
touches the slice it cares about instead of walking the whole
document.

The SDK exports each accessor's return type, for a signature or a field
that has to store one: `MapHandle<T>`, `OrderedMapHandle<T>`,
`ListHandle<T>` and `TextHandle`.

**Make an item the smallest thing two people edit independently.** Two
people editing different items always keep both edits. Two editing the
same item keep one of the two, not a blend, so a grid where people edit
single cells is one item per cell rather than one per row. A small
collection merges more finely than a large one, so a small test is not
proof that your items are the right size.

```ts
type Wall = { type: 'wall'; x: number; z: number };

const walls = doc.map<Wall>('walls');

walls.mutate((m) => { m[id] = { type: 'wall', x: 0, z: 0 }; }); // add
walls.mutate((m) => { const w = m[id]; if (w) w.x = 42; });     // field edit
walls.mutate((m) => { delete m[id]; });                         // remove

const one = walls.get(id);     // Wall | undefined
```

Every handle reads the same way, whether the document opened editable or
read-only: `get`, `has`, `keys()` and `entries()` on a map or ordered map,
and `length()`, `get(index)` and `values()` on a list. `entries()` and
`values()` walk the container. Render from `subscribe`: after its initial
invocation, each subsequent callback delivers only what changed.

When your app reads a container once (such as for an export, summary count, or
comparison), walk it with `entries()` or `values()` instead of creating a subscription.
On large documents, creating a subscription incurs higher overhead because it constructs
change entries for every existing record upon initial delivery.

```ts
let total = 0;
for (const [, wall] of walls.entries()) total += wall.x;
```

The draft indexes as `Record<string, T>`, so a read is `T | undefined`
and the field edit checks it: under `noUncheckedIndexedAccess` that is
the only form that compiles, and either way a peer may have deleted the
record between your render and your click. A record you keep that way is
live, so writing through it writes to the document.

Handles are cached per key (`doc.map('walls') === doc.map('walls')`),
so they compare stable across renders. `doc.list<T>(key)` is the same
surface for a root list; its mutate draft is an array (with a `move`
method, below), and indexed access returns a live element, so find an index then edit it in
place:

```ts
doc.list<Col>('cols').mutate((l) => {
  const i = l.findIndex((c) => c.id === colId);
  const col = l[i];
  if (col) col.name = newName;   // or, when i >= 0, l.splice(i, 1) to remove it
});
```

Reposition an entry with `l.move(from, to)`. Two people moving the same
entry at once converge on one entry, where a removal paired with an
insertion keeps both insertions and leaves the entry in the list twice.

For a keyed collection that has to **stay in a stable order** (a list
of notes, layers, or steps), use `doc.orderedMap<T>(mapKey, orderKey)`
rather than a plain map with an app-computed sort key. It binds the map
to a sibling order list and keeps them in lockstep: a new key appends in
insertion order and a delete prunes from the order, both in the same
commit as the map edit. A hand-rolled key goes wrong here because
nothing gives you a stable number to build one from: a count shifts as
entries are deleted, so a later entry can sort before an earlier one.
Read the collection in order with `entries()` or `keys()`.

```ts
const notes = doc.orderedMap<Note>('notes', 'note_order');
notes.mutate((m) => { m[id] = { text: '' }; });   // appends to the order
notes.mutate((m) => { const n = m[id]; if (n) n.text = 'hi'; });  // order untouched
for (const [key, value] of notes.entries()) renderRow(key, value);
```

`insert(key, value, at)` puts a new key somewhere other than the end,
and `move(key, to)` repositions one the collection already contains. Both
write the record and its place in the order in one commit, the way a
`mutate` add does.

```ts
notes.insert(newId, { text: '' }, { after: caretId });  // Enter, mid-document
notes.move(dragged, { before: droppedOn });             // a drag landing
notes.move(dragged, { index: 0 });                      // send to the top
```

Name a neighbouring key where you have one. A key still anchors where
the user meant after a peer adds or removes a row between your render
and your write, where an index by then counts different rows.
`{ index: n }` counts the positions `keys()` reports and leaves the key
at `n`, or last when `n` is past the end. Two users inserting at one
spot both keep their record, and a user who repositions a record
another deletes leaves the delete standing.

A field edit leaves the order alone, so its `subscribe` fire carries
only `set` / `deleted`. A change that moves the order also carries
`change.order` (the live keys in order). Re-sequence your rows when
`change.order` is present and patch in place otherwise, so a field echo
never disturbs the row a user is editing.

`doc.mutate(fn)` is the simpler surface for tiny documents and
one-liner integrations (a proxy over the default `entities` root). It
operates on the same state as the handles, so an app can mix the two.

Three mutation rules:

- **Edit a nested list by assigning a new array, or through its own
  handle.** `m[id].tags = [...m[id].tags, x]` persists, and you can give
  a list you edit often its own handle with `parent.list(key)`. Nested **maps** walked through the proxy are live.
- **Don't write `undefined`.** Mutations JSON-serialise, so
  `undefined` inside an array becomes `null` and `undefined` property
  values are dropped. Use `null`, length checks, or `'key' in obj`
  instead.
- **Keys are yours except for the `brass:` prefix.** Writing under a key
  that begins with `brass:` throws. Keys under `brass:` never appear in
  `keys()`, `entries()` or `get`, so iterate without filtering.

A document starts **empty**, and the user's first action is their
first undoable edit. Don't seed a baseline from the client: a faked
"initial state" write is an ordinary edit, so Ctrl-Z deletes it and the
user sees content vanish they never wrote. Persist what the user asked
for, and nothing else.

### Prose several people edit

For prose several people edit at once (a description, a report, a comment
body), use `doc.text(key)` rather than storing the string in a map. A map
record is the merge unit, so two people editing one string keep one of the
two and the other's typing is gone. A text container merges inside the
string: `update(next)` diffs against what is stored and applies the
smallest edit that reaches it, so a peer's edit elsewhere in the same
paragraph survives.

Pass the whole new string every time. Diffing it is the handle's job, and
that is what makes a full-string assignment safe here where the same
assignment into a map is not.

```ts
const report = doc.text('report');
let painted = report.read();
field.value = painted;

field.addEventListener('input', () => {
  painted = field.value;
  report.update(painted);
});

report.subscribe((value, origin) => {
  if (origin?.source === 'local') { painted = value; return; }
  paintPeerEdit(value);   // see docs/text-fields.md
});
```

`origin` says who wrote the change, the way a map subscriber's does. The
app's own write comes back through the subscriber too, and it is the one
fire that must not touch the field: the user is already looking at what
they typed. Every other fire has to paint without throwing away the caret
of whoever is typing, which is what `paintPeerEdit` above stands for.

**A text container is a top-level root of the document**, so take one per
document-shaped thing: a body, a section, a summary. Prose that belongs to
each row of a repeated collection stays in the row's record, where the row
is the merge unit and the record store's paging keeps the cost flat as the
collection grows. A root per row opts out of that paging, and each extra root
makes every container in the document cost more, so the cost climbs steeply
with the collection.

[`docs/text-fields.md`](./docs/text-fields.md) carries the caret-preserving
paint, the IME window, what a keystroke costs against the field's length,
and the measurements behind the root-per-row rule.

### Subscribing

`handle.subscribe(cb)` is one channel for every change, whatever
produced it: your own edit, a remote peer's, an undo, a move through
version history. It fires once with the whole container as `change.set`
before `subscribe` returns, then on every change, and each fire carries
what that change wrote, so editing one record costs one entry whatever
the document contains. Subscribe to render and to follow changes. To read a
container once, walk it instead (see [Read and mutate](#read-and-mutate)).
Because the callback executes synchronously during `subscribe` before the method
returns, declare and initialize all variables referenced by the callback before
subscribing to avoid runtime `ReferenceError`s. Your own edits arrive here too,
so render from this single place: updating UI directly at the edit site often
leaves other views showing stale data.

```ts
const stop = walls.subscribe((change) => {
  for (const [id, wall] of change.set) reconcileWall(id, wall); // added or updated
  for (const id of change.deleted) removeWall(id);              // removed
});
```

**Treat the document as the single source of truth.** Write each edit as
your user makes it, and draw what the document says. If you keep a local
model to render from, fill it from `subscribe`.

Assigning to `input.value` moves the caret, so skip a text input while it
has focus and read the document when focus leaves.

```ts
input.addEventListener('input', () => {
  cells.mutate((m) => { m[key] = input.value; });
});
input.addEventListener('blur', () => { input.value = cells.get(key) ?? ''; });

const stop = cells.subscribe((change) => {
  for (const [key, value] of change.set) {
    if (key === editingKey) continue;   // the caret is in this one
    paint(key, value);
  }
});
```

When two people edit one value, the document's merge picks the winner and
every client gets that same answer.

In a declarative framework, bind the input to a per-field ref (`v-model`,
`useState`) rather than to the document, and have your subscriber assign
that ref for every field except the focused one.

**Subscribers execute synchronously inside `mutate()`.** The updated document
state is guaranteed to be in place the moment `mutate()` returns, so subsequent reads
(such as allocating the next ID or validating against existing names) can use current
values immediately.

Similarly, any DOM updates rendered by your subscriber are applied before `mutate()`
returns. You can immediately focus, scroll to, or measure newly created elements
right after calling `mutate()`.

A `list` handle's subscriber receives splices, each carrying the
position an edit lands at, applied in the order they arrive:

```ts
const stop = steps.subscribe((change) => {
  for (const { at, removed, inserted } of change.splices) {
    rows.splice(at, removed, ...inserted.map(renderStep));
  }
});
```

**A reorder arrives as a removal and an insertion, so pair them if the
item owns anything.** Rebuilding is correct and costs whatever state the
item carries: a DOM node loses its focus, its selection and its scroll
position, and a view built on it starts over. As you apply a splice you
know which of your own items it removed, so match them against what the
same change inserts and move the existing item rather than rebuilding it.

```ts
const stop = steps.subscribe((change) => {
  const lifted = new Map<string, Row>();
  for (const { at, removed, inserted } of change.splices) {
    for (const row of rows.splice(at, removed)) lifted.set(row.id, row);
    rows.splice(at, 0, ...inserted.map((step) => lifted.get(step.id) ?? renderStep(step)));
  }
});
```

An `orderedMap` fire also carries `change.order` (the live ids in
order) when the order moves. The optional second callback argument
`origin` (`{ source: 'local' | 'remote' | 'undo' | 'redo' }`) carries
attribution, for a render that highlights a peer's edit. An Undo or Redo
can fire your subscriber several times, once per commit the step took. A
move through
version history swaps the whole container rather than writing into it, so
it arrives with no `origin`; `doc.subscribe` reports that move, with the
version it landed on.

### Knowing when you have the whole container

`handle.onSettled(cb)` fires when the container has been delivered
whole. Use it for work that belongs to the collection rather than to
any one change: framing a camera on what arrived, running a first pass
over it.

```ts
walls.onSettled(() => fitViewTo(walls));
```

It fires on registration, and again each time a version checkout, a
return to head or a hydrate replaces the container, so a user who
moves through history gets the camera framed on the version they landed
on. Set a flag of your own on the first fire for work that should run
once.

It reports what this peer had converged to when the delivery began.
Later changes arrive through `subscribe`. A view built from several
streams is whole once the handle of every stream it reads has settled
(see [Knowing when every stream has arrived](./docs/streams.md#knowing-when-every-stream-has-arrived)).

`doc.subscribe(cb)` is the catch-all for events not tied to one
container (saving-count ticks, branch-list changes). Use it for status
surfaces, and render the editor from handles rather than from a
`doc.subscribe(() => renderAll())` that redraws on every tick.

### Undo, checkpoints, and version history

The `undo` and `redo` commands in the session's command list are fully
wired: the toolbar renders them, and keyboard shortcuts reach them
through `session.run`. Outside the session, call `doc.undo()` /
`doc.redo()` directly and read the enabled state via
`doc.subscribeUndoState(cb)`.

A **checkpoint** (`doc.createCheckpoint()`) is both the Ctrl-Z
boundary and a marker on the document's version-history timeline, so
checkpoint timing sets both granularities. Automatic checkpoints land 60
seconds after each burst of local edits settles. Tune that to your app's shape:

| Your app shape                          | What to do                                                       | Result                                    |
| --------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------- |
| Default / no opinion                    | Only the end-of-action checkpoint below.                         | Plus one 60s after edits settle.          |
| Drag / brush / tool-stroke (3D, canvas) | `void doc.createCheckpoint()` on `pointerup`.                    | One drag = one Ctrl-Z.                    |
| Text editor                             | `void doc.createCheckpoint()` in `beforeinput` (below).          | One typing run or paste = one Ctrl-Z.     |
| Explicit-only                           | `doc.setAutoCheckpointIntervalMs(0)`                             | Only deliberate `createCheckpoint` calls. |

Call `void doc.createCheckpoint()` at the end of every user action. It
ends the Ctrl-Z step at the call, so do not await it in the handler:
the next edit starts a new step either way. Its Promise resolves once
Brass has saved your changes, including edits the user made after the
call, and written the version-history marker. If you await it, catch the rejection it raises when Brass cannot write the
marker, for example because Brass could not save your changes.

In a text editor, typing has no end-of-action event, so decide in
`beforeinput` whether the coming edit joins the open step, and call
`void doc.createCheckpoint()` there when it does not. Make a paste, cut,
drop or line break a step of its own (`inputType` `insertFromPaste`,
`deleteByCut`, `insertFromDrop`, `insertLineBreak` / `insertParagraph`)
by starting a new step before it and before the edit after it. Also
start a new step when the user switches between typing and deleting
(`insert*` and `delete*`), when the edit replaces a selection, and when
it lands away from where the last edit left the caret. Do not shorten
the automatic interval to get this. A shorter interval still ends a step
only at a pause, so one Ctrl-Z undoes everything the user typed since the
last pause, a paste included.

The SDK renders version preview itself: while an earlier version is
showing, `mountToolbar` / `mountHeader` show the "viewing an earlier
version" banner and return-to-live control (mount `mountVersionPreview`
for a fully custom shell). You handle your own edit controls:
`doc.readOnly` flips `true` during a preview, for a user whose access
to the document is view-only, for a view-only share link, while a
document is loading, is being imported, or could not be loaded, and for a
file too large to edit (see [Large imported files](#large-imported-files)).
Gate your custom tools on it, and `doc.mutate` throws while read-only.

Read it inside your `doc.subscribe` handler rather than once when you
bind the editor. It also flips when someone withdraws the user's
access while they have the document open, so re-reading is what
disables your tools at the moment writing stops working. `Brass.onError`
carries the message explaining what happened.

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

The SDK debounces 1.5s after each local edit, screenshots the canvas,
downscales, and uploads.

**WebGL canvases must set `preserveDrawingBuffer: true`** (Three.js:
`new THREE.WebGLRenderer({ preserveDrawingBuffer: true })`). Without it
the read-back is a blank PNG, and the SDK warns once about the missing
flag.

## Presence (live cursors and who's here)

`doc.presence` shows who else is in the document and what they are
doing: a roster of the other live participants plus a small per-user
`state` (cursor, camera, selection). It is non-null on any live open,
editable or `{ readOnly: true }`, `null` on a `{ frozen: true }` copy, and it is fully ephemeral: nothing
survives a disconnect. `Brass.session.presence` is the same client for the
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
`selection` instead. A `selection` grows with what the user picked, so
publish a bounded summary (the first few ids plus a count, or the
selection's bounding box) once a selection can get large, and subscribe
with `presence.onStatus` to catch a layer Brass withholds as oversized.
Set a key to `undefined` to remove it for every peer
(`set({ state: { selection: undefined } })` when the user clears a
selection). `Brass.mountToolbar` and `Brass.mountPresenceRoster` render the header
roster for you. To render remote cursors, diff the roster by
`connectionId` on the `change` event. The full recipe, coordinate
conventions, and types are in [`docs/presence.md`](./docs/presence.md).

## Streams (loading a document in parts)

A document is made of named streams, and each stream loads
independently. When your app opens a document, it downloads only the
streams it reads. Put a heavy part of a document (a terrain mesh, a
point-cloud index) in its own stream, and only the opens that draw it
download it. An importer can split a document the same way, so a
viewer that draws a model opens only its geometry stream:

```ts
const geometry = await doc.stream('geometry'); // downloads this stream only
const records = geometry.orderedMap('instances', 'instance_order');
records.subscribe((change) => draw(change.set));
```

Which call you reach for depends on what you already know about the
document:

- `Brass.openDocumentById(docId, { stream })` opens the document with
  that stream as its own state, so an app that works in one part of a
  large document downloads only that part. It defaults to `'default'`,
  the stream every document has.
- `doc.getOrCreateStream(name)` opens the document's stream of that name
  and creates it if the document does not have it yet. It is idempotent,
  and concurrent callers get the same stream, so your app can call it on
  every open.
- `doc.stream(name)` opens one the document already has and rejects
  any other name. Calling `doc.stream(name)` for the stream the document was
  opened with returns the document itself, allowing a single loop over
  `doc.listStreams()` to handle single-stream and multi-stream documents alike.

Each stream costs one extra round trip to open, so split a document by
what each open loads, not by concept.

A schema names the streams it expects under `streams`. Read only the
streams that contain the records your app needs, because Brass downloads
and decodes each stream you read in full. If your app follows references
into streams it does not otherwise read, read every stream the document
has (`doc.listStreams()`). A document can have streams your schema does
not name, and your app leaves those alone. Naming a stream allows auxiliary
data (such as clash findings, review notes, or cache records) to travel
with the document: they sync and version alongside it, while exporters
compose only the streams they declare, leaving undeclared streams out of
the exported file. See [`docs/streams.md`](./docs/streams.md) and
[`docs/schemas.md`](./docs/schemas.md).

## Imported files

Importers convert standard file types into Brass documents. Your app
opens one through the session and the hosted picker like any other
document. The schema its records follow is what lets a second app open
the same file.

What you build depends on whether an importer for the format already
exists. Open a document of that type in the dashboard to see which case
you are in:

- **It has records and a schema.** An importer for the format
  already exists (an installed app provides it). Adopt the document's
  schema (below) and read and edit the records through the ordinary
  handle surface
  (`doc.orderedMap('instances', 'instance_order')`). Brass re-emits the
  original file on export and drive-push through an installed app that
  serialises the format. A large
  document may spread its records across several streams; if your app
  follows references between records, read every stream the document
  has, see
  [streams](./docs/streams.md#reading-a-document-spread-across-streams).
- **It has only the stored file, with no existing schema.** Nothing imports the
  format yet, so your app is its first importer, and your importer makes
  files of that format openable. Register both halves during application
  startup (unconditionally, not after user sign-in or after a document opens).
  Brass can load your application in a background headless frame specifically
  to run its importer, where no user signs in and no document is displayed.

  ```ts
  Brass.registerImporter(async (file) => {
    const parsed = parseMyFormat(await file.bytes());
    const instances: Record<string, unknown> = {};
    for (const r of parsed) instances[r.id] = { type: r.type, params: r.body };
    return {
      streams: {
        default: { instances, instance_order: parsed.map((r) => r.id) },
      },
    };
  });
  Brass.registerSerializer((doc) => serializeMyFormat(doc));
  ```

  The importer takes the file and returns the document's content as JSON.
  Brass runs it when a document needs an import, and every client with
  the document open then receives the whole result together.
  Declare the `schema` of the records your importer returns in
  `brass-app.json`; importing publishes that schema and stamps it on
  the document, so the next app can adopt it like any imported
  document's. Declare the file match there too
  (`"imports": [{ "extension": "gpx" }]`) so Brass runs your importer on
  files of that type.

To make your app open documents of an existing file type, adopt that
type's schema rather than re-derive its record shape. Get a document of
the shape you target: upload a sample file to your organization, or open
one that another app produced. Copy its schema from the document's page
in the dashboard (**Download brass-app.json**, or
`npx @brass-build/cli schema pull --doc <docId>`), keep it verbatim as
`schema` in your `brass-app.json`, and ship that manifest with your
first deploy. The schema describes each record's keys and value shapes.
Inspect records before writing code against them:
`npx @brass-build/cli contents --doc <docId>` outputs the default stream as
JSON (add `--stream <name>` to view another stream). The picker lists
documents matching your declared schema, and Brass adds the matching family to
your `opens` list so compatible documents route to your app and remain
interoperable with other apps editing them.

Every app ships a capability manifest at `/.well-known/brass-app.json`
in its bundle root, next to `index.html`. It declares the schema your
app works with, the files it imports, the format it exports, and the
icon the platform renders as your app's mark. The platform re-reads it
after each deploy, so publishing your bundle is what registers it.
[`docs/app-manifest.md`](./docs/app-manifest.md) covers where the file
goes, what each key does, and how to confirm your build carries it.

[`docs/imported-documents.md`](./docs/imported-documents.md) covers the
record store an imported file becomes, and
[`docs/schemas.md`](./docs/schemas.md) covers declaring its schema.

## Referencing other documents

Your app can reference other documents as inputs. For example, you can calculate the total
floor area from multiple CAD models across several projects. Brass automatically
tracks referenced documents and notifies your app when any of them change, even
if they were edited while your document was closed.

### Choosing inputs

`Brass.chooseInputs(families, options?)` opens the hosted picker where the
user selects files, folders, and projects. Pass the families to offer,
such as `['ifc']` for IFC models. Each family must be listed in your manifest's
`opens` or declared as an `inputs` schema `family`
([`docs/app-manifest.md`](./docs/app-manifest.md)). The picker offers a
document only when it satisfies all required fields of a declared schema, so
require only the fields your code reads.

To find the families an organization's files belong to, run:

```sh
npx @brass-build/cli contents --from organization:<id> --max-documents 0
```

Files listed with no `family` have no registered importer and are not
offered by the picker.

`Brass.chooseInputs` resolves with:
- `InputReference[]`: The selected references. If the user deselects all inputs
  and confirms, it resolves with an empty array (`[]`).
- `null`: The user dismissed or closed the picker without confirming. Keep the
  references your app already has.

A reference (`InputReference`) identifies a chosen file, folder, or project,
and records the families and filter criteria under which it was selected. Pass
current references as `selected` so the picker opens with them pre-selected.
The picker expands zip archives into folders, allowing users to select an
archive or files inside it without your app declaring a zip importer.

To pick a single file (such as a symbol library or reference standard), call
`Brass.chooseInput(families, options?)`. It opens a single-file selection dialog
and resolves with an `InputReference`, or `null` if the user closes the dialog.
On `null`, keep your existing reference. Pass the current reference as
`selected` on the next call to highlight that file. To let the user remove the
reference, provide a clear button in your app UI and clear the reference yourself.

Both picker methods support these options:
- `selected`: Current `InputReference[]` (or `InputReference` for `chooseInput`) to mark as selected.
- `accept`: Narrow offered files by name or extension (`{ names?: string[], extensions?: string[] }`).
- `prompt`: A custom instruction string displayed in the picker header.

Record chosen references in the document with `doc.dependsOn(key, refs)`,
and clear a key with `doc.dependsOn(key, null)`. Assign a distinct key for each
set of inputs (such as `'areas@v1'` or `'rates@v1'`), so independent parts of
your app manage their references separately without conflicting. When your calculation logic
or schema changes, switch to a new key (such as `'areas@v2'`), which reprocesses
every input from scratch, and clear the deprecated key. A document cannot depend
on itself.

Because `doc.dependsOn()` mutates the document, Undo reverts dependency changes
alongside edits made in the same action. It throws an error on a read-only document,
so verify `!doc.readOnly` before displaying picker buttons, or upgrade with
`await doc.reopen()`.

To record references on a specific [stream](#streams-loading-a-document-in-parts),
call `stream.dependsOn(key, refs)` and follow them with
`stream.subscribeInputDocuments(key, handlers)`.

### Reacting to changes

A key's inputs are the documents its references include: each directly referenced
document, and every document in a referenced folder or project that matches the
families and `accept` criteria under which the reference was chosen. A reference
to a project or folder stops at an archive inside it; to read an archive's contents,
reference the archive itself.

`doc.subscribeInputDocuments(key, handlers, options)` calls your handlers with
the key's inputs and returns an unsubscribe function. Pass the handlers that
match where your app stores what it reads:

- `loaded(input)` runs for every input each time you subscribe, including after
  a page reload, and again for each new version. It runs for every user, including
  view-only users. Use it for state your app keeps in memory, such as a viewer
  that draws every model. To list or table the inputs, render `status.inputs` (below)
  instead, which opens none of them.
- `changed(input)` runs for each input added or edited since your document last
  read it, including edits made while nobody had your document open. Newly picked
  inputs count as added and pass to `changed`. When the handler resolves, Brass
  records that your document has read the input at that version, so subsequent
  sessions and collaborators do not re-read it. Use it for results your app stores
  in your document. It runs only for users with edit access.
- `removed(docId)` runs once for each input that is no longer among the key's
  inputs (deleted or moved out of every referenced folder and project). Every user
  runs it for inputs passed to `loaded`, and an editor also runs it for inputs your
  document read in an earlier session. Clean up stored or cached results here.

Pass both when your app does both, such as a viewer that draws each model from
`loaded` and stores each model's clash count from `changed`. Brass never runs two
handlers for one input at the same time.

When several subscriptions to one key on a document are live, each input's call
runs the handlers of every subscription side by side, and Brass records a
`changed` input as read only after every subscription's `changed` has resolved.
If one rejects, Brass retries that subscription alone. In a framework component,
return the unsubscribe function from your effect's cleanup. Otherwise the
subscription outlives its component, keeps writing results, and delays Brass
recording inputs as read.

`input` carries `doc_id`, `name`, `family` (absent on a document with none),
`updated_at`, and `from` (the references that include it, nearest first). Call
`input.open(options)` to read its content. It accepts the same options as
`Brass.openDocumentById`:
- From `changed`, open with `{ frozen: true }`, so the handler reads a snapshot
  without opening a real-time connection.
- From `loaded`, open with `{ readOnly: true }`, so a viewer receives live updates
  without write overhead.

Calling `input.open` again in the same handler with matching options returns the
same document instance; calling it with different options closes the previous
copy and opens a new one.

Brass automatically closes the document returned by `input.open` when your handler
resolves, and logs a warning if your app uses it after that. To keep it open
between calls (such as in a viewer that keeps every model loaded and subscribed to),
pass `{ keepDocumentsOpen: true }`. Subsequent `input.open` calls for that input,
from `loaded` or `changed`, then return the same document, reloaded at the new
version if frozen. Brass closes it when the input is removed or you unsubscribe.
Call `input.close()` to close it earlier.

**Writing results with `{ undoable: false }`.** Write each input's result in
`changed` using `mutate(draft, { undoable: false })`, so user Undo actions leave
derived results in place, and delete it in `removed`. Compute each result from that
input alone, and write deterministic results for the same input wherever it runs.

**Concurrency and retries.** Brass calls handlers for multiple inputs concurrently
and automatically paces them. Brass never calls a handler for an input while an
earlier call for it is still running. If an input is edited while your handler reads
it, Brass calls the handler again with the new version and discards the earlier call.
Leave the pace to Brass unless each handler spends something rationed, such as
calls to a paid third-party API. To cap how many run at once for such a handler,
pass `{ concurrency: n }`. A lower cap makes reading many inputs take longer.
A handler that rejects leaves the input unread, and Brass retries with
exponential backoff (2 seconds up to 5 minutes), so do not retry it yourself. If `input.open` rejects with `'not_imported'`,
show `error.message` for that input and rethrow. Its import runs only when someone
opens the file in the app that imports its type, so Brass does not retry it on the
backoff and instead re-invokes your handler once that app has imported the file.

To read an input on demand (such as when its table row scrolls into view), keep its
handler pending until then and call `input.open` before the handler resolves. A
pending handler does not delay handlers for other inputs, and `status.settled` stays
`false` until it resolves.

`handlers.status(status)` receives the key's status, and again whenever it changes:

- `status.refs` lists the key's references. Pass them back to `chooseInputs` as
  `selected`.
- `status.inputs` lists the inputs this user can open, with the same fields as
  `input`. Render lists directly from this array without opening documents. To
  render the enclosing folders for an input, read `member_of.chain` from
  `Brass.documents.get(input.doc_id)`: the folders and archives above it, outermost
  first, ending with the folder or archive `member_of` names.
- `status.hidden_count` counts inputs your document read before that this user
  cannot open. When greater than zero, notify the user that results include inputs
  they cannot see.
- `status.truncated` is `true` when your document's keys together include more
  inputs than a document tracks. Notify the user that some inputs are omitted.
- `status.settled` is `false` while the list of inputs may not be complete (such
  as right after `dependsOn`), and until every handler you passed has finished for
  every input and inputs have stopped changing. Display progress indicators while
  it is `false`. A rejected handler counts as finished, so `settled` can turn `true`
  with errors outstanding; store each error in your handler and show it in the
  input's row.

`handlers.settled(status)` runs each time `status.settled` turns `true`: after the
first load, and again after each later batch of additions, edits, or removals. A
burst of inputs arriving together (such as a drive's first listing) produces one
call. Run work that reads every input's result together here (such as numbering
doors across models, or combining results with a second key's inputs, such as a
rate table), so a change to either updates every result. Because every user runs it,
write to the document only when `!doc.readOnly`.

### Example

The user picks projects, and a report shows the floor area of each model
in them. Each model's area appears as soon as its `changed` handler
finishes, and the total updates with each one:

```ts
import type { Document, InputReference } from '@brass-build/client';

const KEY = 'areas@v1';
let report: Document | null = null;
let refs: InputReference[] = [];
let unbind: (() => void) | null = null;

// Called from `session.subscribe` whenever `session.document` changes.
function bindReport(doc: Document | null) {
  unbind?.();
  unbind = null;
  report = doc;
  if (!doc) return;
  const areas = doc.map<number>('areas');
  const stopInputs = doc.subscribeInputDocuments(KEY, {
    async changed(input) {
      const model = await input.open({ frozen: true });
      const area = sumFloorArea(model);
      areas.mutate((draft) => { draft[input.doc_id] = area; }, { undoable: false });
    },
    removed(docId) {
      areas.mutate((draft) => { delete draft[docId]; }, { undoable: false });
    },
    status(status) {
      refs = status.refs;
      showProgress(!status.settled);
    },
  });
  const stopTotal = areas.subscribe(() => renderTotal(areas));
  unbind = () => { stopInputs(); stopTotal(); };
}

async function choose() {
  const doc = report;
  if (!doc || doc.readOnly) return;
  const picked = await Brass.chooseInputs(['ifc'], { selected: refs });
  // The session may have bound another document while the picker was open.
  if (picked !== null && report === doc) doc.dependsOn(KEY, picked);
}
```

Every `doc.reopen()` passes a new document instance to `session.subscribe`, so
unsubscribe the old document's inputs before you subscribe the new one's,
as `bindReport` does.

To reference a single library file (such as a symbol catalog), pass the library's
family to `Brass.chooseInput` (`npx @brass-build/cli contents --from organization:<id> --max-documents 0`
lists each file's `family`), and record the returned reference with
`doc.dependsOn(key, [ref])`. When collaborators edit the library, Brass calls
`changed` with it: open it with `{ frozen: true }` and update the placements that
use it.

## Calling an outside service

Your app can call a paid or authenticated third-party API without ever
having its credential. Declare the host in `brass-app.json`, and Brass adds
the key to each request:

```json
{
  "services": [{ "host": "api.anthropic.com", "headers": { "x-api-key": "{secret}" } }]
}
```

Whoever owns the account enters the secret in Brass, either as one key of
yours that serves every install, or as a request for whoever runs your app to
connect their own account. `Brass.callService` returns the service's response unchanged:

```js
const res = await Brass.callService('api.anthropic.com', 'v1/messages', {
  body: JSON.stringify({
    model: 'claude-sonnet-5',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }],
  }),
  headers: {
    'content-type': 'application/json',
    'anthropic-version': '2023-06-01',
  },
});
const message = await res.json();
```

`options.method` defaults to `'POST'`. The response must be text, under 5 MB,
and arrive within 25 seconds. Brass does not follow redirects: a `3xx` is
returned as `response_redirected`, with the service's `location` in the body.

`Brass.listServices()` tells you which hosts have a credential, so you can
show or hide a feature before anyone clicks it.
`Brass.connectService(host)` opens the dialog that collects a missing one:

```js
const services = await Brass.listServices();
const ai = services?.find((s) => s.host === 'api.anthropic.com');
if (ai?.ready) showSummariseButton();
else upgradeButton.onclick = () => Brass.connectService('api.anthropic.com');
```

When Brass refuses a call rather than sending it, the response body has a
`code` for what to do about it:

```js
if (!res.ok) {
  const { code } = await res.json();
  if (code === 'credential_required') await Brass.connectService('api.anthropic.com');
}
```

[`docs/services.md`](./docs/services.md) lists every code, and covers values
only the user knows and services split across several addresses.
[`docs/app-manifest.md`](./docs/app-manifest.md) covers declaring a host,
including services that sign a request or exchange a credential for a token.

## Reference

`Brass` is the top-level namespace your app calls. The package's
TypeScript types document `Document` and the container handles, so your
editor's autocomplete lists every member and signature, and the examples
above show them in use.

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
| `Brass.callService(host, path, options?)`                    | `Promise<Response>`                     |
| `Brass.listServices()`                                       | `Promise<AppServiceState[] \| null>`    |
| `Brass.connectService(host)`                                 | `Promise<boolean>`                      |
| `Brass.session`                                              | `DocumentSession` (see above)           |
| `Brass.mountToolbar(el, options?)`                           | `SessionToolbarHandle` (`{ tools, destroy }`) |
| `Brass.createDocument(options?)`                             | `Promise<OpenedDocument>` (`session.create` drives this) |
| `Brass.openDocumentById(docId, options?)`                    | `Promise<OpenedDocument>` (the session's `open` drives this); `ReadOnlyDocument` for `readOnly: true` or `frozen: true` |
| `Brass.chooseInputs(families, options?)`                  | `Promise<InputReference[] \| null>` (what this user has chosen for your app) |
| `Brass.chooseInput(families, options?)`                   | `Promise<InputReference \| null>` (one file this user has chosen) |
| `Brass.shareDocument(docId)`                                 | `Promise<void>`                         |
| `Brass.registerImporter(fn)`                                 | `void` (see `docs/imported-documents.md`) |
| `Brass.registerSerializer(fn)`                               | `void` (see `docs/imported-documents.md`) |
| `Brass.documents`                                            | namespace getter (metadata read, thumbnails)       |

The composable header mounts (`mountHeader`, `mountFileMenu`,
`mountDocumentTitle`, `mountUndoRedo`, `mountPresenceRoster`,
`mountDriveSync`, `mountAccountMenu`, `mountVersionPreview`) live in
[`docs/custom-chrome.md`](./docs/custom-chrome.md).

`OpenedDocument = Document & { readonly id: string }`. Open / create
methods return `OpenedDocument`, so type app-level variables as
`OpenedDocument` and `doc.id` stays non-null. `BrassUser` is
`{ sub: string; email?: string; display_name?: string; avatar_url?: string }`.

### Errors

Every rejecting call rejects with a `BrassError`. HTTP calls carry
`.status: number`, and hosted-UI launchers and API operations provide an actionable `.code`:

| Code | Where it occurs | What to do |
| ---- | --------------- | ---------- |
| `'embed_error'` | Hosted UI dialogs (`session.open()`, `shareDocument()`) | The dialog failed to load or communicate. Display `error.message`. |
| `'not_in_browser'` | Hosted UI dialogs | Called in an environment without DOM/browser globals. Run only in browser contexts. |
| `'iframe_unavailable'` | `chooseInputs()`, `chooseInput()` | The browser blocked the picker iframe (e.g. strict CSP or partitioned storage). Display `error.message` and keep existing references. |
| `'app_not_granted'` | Opening a document via ID | Your app was not granted access to this document. Have the user pick the document through `session.open()` to grant access. |
| `'not_imported'` | Opening a file whose type another app imports | The import runs only when someone opens the file in that app. Show `error.message` rather than a loading state, since nothing is in progress. In a `subscribeInputDocuments` handler, show it and rethrow, and Brass re-invokes the handler once that app has imported the file. |

Calls made without an active session reject with `status === 401` locally before
reaching the network. Reopening an editable copy on a document where the user only has
view access rejects with `status === 403`.

## Guides

- [`AGENTS.md`](./AGENTS.md): instructions for AI coding agents, covering driving the sign-in, the review loop, the UX defaults a generated app should meet, and shipping it to a published URL.
- [`docs/app-manifest.md`](./docs/app-manifest.md): the `brass-app.json` capability manifest every app ships, where it goes in your bundle, and what each key declares.
- [`docs/imported-documents.md`](./docs/imported-documents.md): the record store an imported file becomes, `Brass.registerImporter`, `doc.sourceBlob()`, and `Brass.registerSerializer`.
- [`docs/schemas.md`](./docs/schemas.md): declaring a schema, creating a stream, what lets an app open a document, and what breaks that.
- [`docs/streams.md`](./docs/streams.md): splitting a document into streams that load independently, opening one, adding one, and reading a document spread across streams.
- [`docs/custom-chrome.md`](./docs/custom-chrome.md): composable header pieces, and rendering `session.commands` yourself for a fully custom shell.
- [`docs/text-fields.md`](./docs/text-fields.md): binding a field to `doc.text(key)`, painting a peer's edit without losing the caret, the IME window, what a keystroke costs, and where a text container belongs in a document.
- [`docs/services.md`](./docs/services.md): calling a declared outside service, every refusal code, values only the user knows, and a service split across addresses.
- [`docs/presence.md`](./docs/presence.md): remote cursors, roster rendering, coordinate conventions, full types.
- [`docs/hosted-ui-advanced.md`](./docs/hosted-ui-advanced.md): the hosted launchers (`Brass.session.open()`, `Brass.shareDocument`), their redirect behavior in browsers that block the iframe, theming, CSP.
