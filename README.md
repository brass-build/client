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

**Or wire it by hand.** Six calls, and your own code around them:

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

// The whole file menu in one call: document title, undo / redo,
// account menu, presence roster.
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
npx @brass-build/cli login          # opens your browser to sign in
npx @brass-build/cli publish ./dist
```

The first publish creates the app, hosts it at
`https://<slug>.onbrass.app` where your users sign in, and reports the
app id (the `brass_app_...` above).

## Setup

To take the [quickstart](#quickstart) from source to a
signed-in, hosted app:

1. **Ship it.** `npx @brass-build/cli publish ./dist` creates the app,
   hosts it, and returns its sign-in URL. See [Ship it](#ship-it).
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
3. **Allow your development origin.** An app you create in the dashboard
   already allows sign-in from `localhost` / `127.0.0.1` on any port. One
   a first `brass publish` created for you carries only the origin it is
   served from, so add `http://localhost:5173/*` on your app's page before
   signing in locally. A missing entry answers that the origin is not on
   the app's allowlist.

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

Boot also requests `/.well-known/brass-runtime.json`. Brass serves that
file from its own hosting to tell a bundle which app and environment it
is being served as. Your own origin has no reason to, so it answers
either a 404 (which the console logs in red) or, if it falls back to
`index.html` the way a dev server does, that page. Both are expected,
and the SDK carries on with the app id and origins you gave it.

### Vite dev server

Vite pre-bundles your dependencies for its dev server, which copies this
package into `node_modules/.vite/deps/` without moving the engine's binary
alongside it. The request for the binary then resolves inside that
directory, finds nothing, and the dev server answers with `index.html`, so
the engine is handed a page to compile and the app fails when it first
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
| `openIncompatibleDocuments` | `false` (Brass refuses to open a document your schema cannot read, and asks the person whether to go ahead) |

`Brass.init` resolves once it knows who the reader is, which takes one
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
npx @brass-build/cli publish ./dist
```

The first publish creates the app, enables hosting, uploads the build,
and writes the app id to `.brass/project.json`. Commit that file so
later publishes and your teammates target the same app.

Run `brass login` once first to authenticate (it opens your browser),
or set `BRASS_SERVICE_TOKEN` in a pipeline. The CLI also pulls a
document's schema into your `brass-app.json`. See
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

`'guest'` is the "anyone with the link" case: someone opened a public
view link, so there is no signed-in user but `Brass.session` still
opens the shared document **read-only** for them (`Brass.isGuest` is
`true`). When the page URL carries the link token, the session boots
that read-only document on its own.

`Brass.onUserChange` is the single source for reacting to auth
changes. It fires once when `init` resolves (with the real user or
`null`), then on every sign-in and sign-out. A listener registered
before `init` does not fire on registration. One registered after does.

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
<AppShell        v-else /> <!-- signed-in or guest (read-only) -->
```

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

**Mount it once when the user signs in, not when a document opens.**
New and Open live in its file menu, so a user who has just signed in
reaches a first document only through a bar that is already there. It
re-renders itself as documents open, switch, and close. It takes
options `{ presence?, account?, drive? }` (all default to `true`), and
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
| `signed-out` | No signed-in user.                       | The sign-in CTA.                     |
| `empty`      | Signed in, no document open.             | "No document open. Use New or Open." |
| `loading`    | An open / create is in flight.           | A spinner or progress bar (below).   |
| `ready`      | A document is open (`session.document`). | Your editor.                         |
| `error`      | A document couldn't be opened, or the open one was deleted.| `session.error.message` + your recovery actions (below) |

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

**Work on an open document.** Brass prepares an imported file, syncs a
document to its drive, and does other work while the document is open.
`doc.status` carries that work and reads `null` when there is none;
`doc.onStatus(cb)` fires on every phase. Render `status.message`
verbatim and read `status.pending` for whether the work is still
running. The message is prose written for the reader, so show it rather
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

`session.pick()` is the same call for opening an existing document: it
raises the hosted picker and binds what the reader chooses, resolving
`null` if they cancel. Both back the toolbar's own New and Open, so reach
for them when your app renders those buttons itself (an empty state
offering somewhere to start, a shortcut).

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

The session's Open and Share commands invoke the hosted dialogs
(`Brass.selectDocument()`, `Brass.shareDocument()`) for you, so
browsing, picking, and sharing an existing document take no code.

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
hands you a fresh instance on every open, and a version preview is a
new instance with the same id, so an id comparison would skip the
rebind and strand your editor on the previous state.

### Read and mutate

The primary editing surface is a **typed container handle**:
`doc.map<T>(key)` returns a scoped reference to one root container,
and its `subscribe`, `mutate`, and `get` only see (and only pay for)
that container. A large document stays cheap because your editor
touches the slice it cares about instead of walking the whole
document.

The SDK exports each accessor's return type, for a signature or a field
that has to hold one: `MapHandle<T>`, `OrderedMapHandle<T>`,
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

The draft indexes as `Record<string, T>`, so a read is `T | undefined`
and the field edit checks it: under `noUncheckedIndexedAccess` that is
the only form that compiles, and either way a peer may have deleted the
record between your render and your click. A record you hold that way is
live, so writing through it writes to the document.

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
Read the collection in order with `ordered()` or `keys()`.

```ts
const notes = doc.orderedMap<Note>('notes', 'note_order');
notes.mutate((m) => { m[id] = { text: '' }; });   // appends to the order
notes.mutate((m) => { const n = m[id]; if (n) n.text = 'hi'; });  // order untouched
for (const { key, value } of notes.ordered()) renderRow(key, value);
```

`insert(key, value, at)` puts a new key somewhere other than the end,
and `move(key, to)` repositions one the collection already holds. Both
write the record and its place in the order in one commit, the way a
`mutate` add does.

```ts
notes.insert(newId, { text: '' }, { after: caretId });  // Enter, mid-document
notes.move(dragged, { before: droppedOn });             // a drag landing
notes.move(dragged, { index: 0 });                      // send to the top
```

Name a neighbouring key where you have one. A key still anchors where
the reader meant after a peer adds or removes a row between your render
and your write, where an index by then counts different rows.
`{ index: n }` counts the positions `keys()` reports and leaves the key
at `n`, or last when `n` is past the end. Two readers inserting at one
spot both keep their record, and a reader who repositions a record
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
  handle.** `m[id].tags = [...m[id].tags, x]` persists wherever the
  record is stored, and `parent.list(key)` gives a list you edit often a
  handle of its own. Nested **maps** walked through the proxy are live.
- **Don't write `undefined`.** Mutations JSON-serialise, so
  `undefined` inside an array becomes `null` and `undefined` property
  values are dropped. Use `null`, length checks, or `'key' in obj`
  instead.
- **Keys are yours except for the `brass:` prefix.** A map keeps its own
  bookkeeping beside your records, under keys beginning with `brass:`,
  so a write under one is refused. Any other key is free.

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
fire that must not touch the field: the reader is already looking at what
they typed. Every other fire has to paint without throwing away the caret
of whoever is typing, which is what `paintPeerEdit` above stands for.

**A text container is a top-level root of the document**, so take one per
document-shaped thing: a body, a section, a summary. Prose that belongs to
each row of a repeated collection stays in the row's record, where the row
is the merge unit and the record store's paging holds the cost flat as the
collection grows. A root per row opts out of that paging, and loro prices a
container against how many the document holds, so the cost climbs steeply
with the collection.

[`docs/text-fields.md`](./docs/text-fields.md) carries the caret-preserving
paint, the IME window, what a keystroke costs against the field's length,
and the measurements behind the root-per-row rule.

### Subscribing

`handle.subscribe(cb)` is one channel for every change, whatever
produced it: your own edit, a remote peer's, an undo, a move through
version history. It fires once on registration with the whole container as
`change.set`, then on every change, and each fire carries what that
change wrote, so editing one record costs one entry whatever the
document holds. Your own edits arrive here too, so render
from this one place: an app that also paints at the edit site updates
the field it touched and leaves a header showing the same value stale.

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

**A subscriber runs inside the `mutate` that caused it**, so what it
gave you is current the moment `mutate` returns. Answer a read straight
after a write (allocating the next id, checking a new name against the
ones in use) from what you already hold.

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
item owns anything.** Rebuilding is correct and costs whatever the item
holds: a DOM node loses its focus, its selection and its scroll
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
attribution, for a render that highlights a peer's edit. A move through
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
return to head or a hydrate replaces the container, so a reader who
moves through history gets the camera framed on the version they landed
on. Set a flag of your own on the first fire for work that should run
once.

It reports what this peer had converged to when the delivery began.
Later changes arrive through `subscribe`.

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
checkpoint timing sets both granularities. Automatic checkpoints land 60
seconds after each burst of local edits settles. Tune that to your app's shape:

| Your app shape                          | What to do                                       | Result                                     |
| --------------------------------------- | ------------------------------------------------ | ------------------------------------------ |
| Default / no opinion                    | Nothing.                                         | A checkpoint every 60s of idle.            |
| Drag / brush / tool-stroke (3D, canvas) | `void doc.createCheckpoint()` on `pointerup`.    | One drag = one Ctrl-Z.                     |
| Text editor / fast bursts               | `doc.setAutoCheckpointIntervalMs(2000)` at boot. | Each typing pause becomes a boundary.      |
| Explicit-only                           | `doc.setAutoCheckpointIntervalMs(0)`             | Only deliberate `createCheckpoint` calls.  |

`createCheckpoint()` waits for the edits your app has just made to save
before it marks the point, so the marker describes the state you asked to
save rather than one those edits are missing from. It rejects on a rate
limit, and when those edits do not save. A missed checkpoint is harmless,
so call it fire-and-forget.

The SDK renders version preview itself: while an earlier version is
showing, `mountToolbar` / `mountHeader` show the "viewing an earlier
version" banner and return-to-live control (mount `mountVersionPreview`
for a fully custom shell). You handle your own edit controls:
`doc.readOnly` flips `true` during a preview, for a reader whose access
to the document is view-only, for a view-only share link, and while a
document is loading or could not be loaded. Gate your custom tools on
it, and `doc.mutate` throws while read-only.

Read it inside your `doc.subscribe` handler rather than once when you
bind the editor. It also flips when someone withdraws the reader's
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
`state` (cursor, camera, selection). It is non-null on any open
writable document, and it is fully ephemeral: nothing survives a
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
`selection` instead. A `selection` grows with what the user picked, so
publish a bounded summary (the first few ids plus a count, or the
selection's bounding box) once a selection can get large, and subscribe
with `presence.onStatus` to catch a layer Brass withholds as oversized.
`Brass.mountToolbar` and `Brass.mountPresenceRoster` render the header
roster for you. To render remote cursors, diff the roster by
`connectionId` on the `change` event. The full recipe, coordinate
conventions, and types are in [`docs/presence.md`](./docs/presence.md).

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

Which call you reach for depends on what you already know about the
document:

- `Brass.openDocumentById(docId, { stream })` opens the document with
  that stream as its own state, so an app that works in one part of a
  large document downloads only that part. It defaults to `'default'`,
  the stream every document has.
- `doc.getOrCreateStream(name)` opens the document's stream of that name
  and makes it when the document does not hold it yet. It is idempotent,
  and concurrent callers converge on one stream, so your app reaches for
  the stream it expects on every open.
- `doc.stream(name)` opens one the document already holds and rejects
  any other name. Ask it for the stream you opened the document at and
  you get the document back, so one loop over `doc.listStreams()` reads
  a partitioned and an unpartitioned document alike.

A stream costs one extra round trip, so add one when it carries real
content: partition by load unit (a discipline, a heavy layer), not by
concept.

A schema names the streams it expects under `streams`. If your app
follows references between records, read every stream the document holds
(`doc.listStreams()`). A document can hold streams your schema does not
name, and your app leaves those alone. Naming a stream is how records
you work with (clash findings, review notes, a cache) ride in the
document: they sync and version with it, and an exporter composes only
the streams it declares, so records in a stream it does not name stay
out of the exported file. See [`docs/streams.md`](./docs/streams.md) and
[`docs/schemas.md`](./docs/schemas.md).

## Imported files

Importers convert standard file types into Brass documents. Your app
opens one through the session and the hosted picker like any other
document. The schema its records follow is what lets a second app open
the same file.

What you build depends on whether an importer for the format already
exists. Open a document of that type in the dashboard to see which case
you are in:

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
- **It holds the stored file under no schema.** Nothing imports the
  format yet, so your app is its first importer, and your importer is
  what makes files of that format openable. Register both halves at
  boot: the importer parses the stored file into records, the serializer
  reconstitutes the file from them.

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
  (`"imports": [{ "extension": "gpx" }]`) so Brass runs your importer on
  files of that type.

To make your app open documents of an existing file type, adopt that
type's schema rather than re-derive its record shape. Get a document of
the shape you target: upload a sample file to your organization, or open
one that another app produced. Copy its schema from the document's page
in the dashboard (**Download brass-app.json**, or
`npx @brass-build/cli schema pull --doc <docId>`), keep it verbatim as
`schema` in your `brass-app.json`, and ship that manifest with your
first deploy. The picker lists documents by matching your declared
schema, and its family folds into your `opens`, so documents of that
shape route to your app and your code stays compatible with the other
apps that edit them.

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

## Calling an outside service

Your app can call a paid or authenticated third-party API without ever
holding its credential. Declare the host in `brass-app.json`, and Brass adds
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
| `Brass.openDocumentById(docId, options?)`                    | `Promise<OpenedDocument>` (the session's open / pick path drives this) |
| `Brass.selectDocument()`                                     | `Promise<SelectDocumentResult \| null>` (the pick; also render from the session, see `docs/hosted-ui-advanced.md`) |
| `Brass.shareDocument(docId)`                                 | `Promise<void>`                         |
| `Brass.registerImporter(fn)`                                 | `void` (see `docs/imported-documents.md`) |
| `Brass.registerSerializer(fn)`                               | `void` (see `docs/imported-documents.md`) |
| `Brass.documents`                                            | namespace getter (metadata read and thumbnails for a known doc id) |

The composable header mounts (`mountHeader`, `mountFileMenu`,
`mountDocumentTitle`, `mountUndoRedo`, `mountPresenceRoster`,
`mountDriveSync`, `mountAccountMenu`, `mountVersionPreview`) live in
[`docs/custom-chrome.md`](./docs/custom-chrome.md).

`OpenedDocument = Document & { readonly id: string }`. Open / create
methods return `OpenedDocument`, so type app-level variables as
`OpenedDocument` and `doc.id` stays non-null. `BrassUser` is
`{ sub: string; email?: string; display_name?: string; avatar_url?: string }`.

### Errors

Every call rejects with one error type, `BrassError`. HTTP calls carry
`.status: number`, and the hosted-UI launchers (`selectDocument`,
`shareDocument`, ...) carry `.code` (`'embed_error'`,
`'not_in_browser'`). A call made without a signed-in session rejects
with `.status === 401` before it reaches the network.

## Guides

- [`AGENTS.md`](./AGENTS.md): instructions for AI coding agents, covering the review loop, the UX defaults a generated app should meet, and shipping it to a published URL.
- [`docs/app-manifest.md`](./docs/app-manifest.md): the `brass-app.json` capability manifest every app ships, where it goes in your bundle, and what each key declares.
- [`docs/imported-documents.md`](./docs/imported-documents.md): the record store an imported file becomes, `Brass.registerImporter`, `doc.sourceBlob()`, and `Brass.registerSerializer`.
- [`docs/schemas.md`](./docs/schemas.md): declaring a schema, creating a stream, what lets an app open a document, and what breaks that.
- [`docs/streams.md`](./docs/streams.md): partitioning a document for lazy loading, per-stream undo, and reading a document spread across streams.
- [`docs/custom-chrome.md`](./docs/custom-chrome.md): composable header pieces, and rendering `session.commands` yourself for a fully custom shell.
- [`docs/text-fields.md`](./docs/text-fields.md): binding a field to `doc.text(key)`, painting a peer's edit without losing the caret, the IME window, what a keystroke costs, and where a text container belongs in a document.
- [`docs/services.md`](./docs/services.md): calling a declared outside service, every refusal code, values only the user knows, and a service split across addresses.
- [`docs/presence.md`](./docs/presence.md): remote cursors, roster rendering, coordinate conventions, full types.
- [`docs/hosted-ui-advanced.md`](./docs/hosted-ui-advanced.md): the hosted launchers (`Brass.selectDocument`, `Brass.shareDocument`), their redirect behavior in browsers that block the iframe, theming, CSP.
