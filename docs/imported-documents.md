# Imported files and formats

Your app reads and edits an imported document through the ordinary
handle surface, and Brass does the importing. A user uploads a file or
opens a drive item, and the platform turns it into a document, so there
is no client import call to make. How much of the file mapping you write
yourself depends on whether the format already has an importer:

- **A format with an importer**: the parsed records ARE the document
  (an installed app provides the importer). You read and edit the
  records through the ordinary handle surface, and Brass re-emits the
  original on export and drive-push through an installed app that
  serialises the format. Your app is an **editor**: declare the
  document's schema in `brass-app.json`, the contract peers evaluate
  compatibility against. The schema is also the record contract: its
  `description`s declare how each field is encoded, so an analysis app
  derives what it computes (a tree, geometry, quantities) from the
  records the schema describes. A large document spreads those records
  across the streams the schema names, so read them all (see [Reading a
  document spread across
  streams](./streams.md#reading-a-document-spread-across-streams)).
- **Any other file**: the document is an opaque file (source
  `schema_type` is `brass:file`). Your app is the importer/exporter:
  it registers its parser with `Brass.registerImporter` (Brass runs it
  on the stored bytes and stamps your schema on the document) and the
  inverse with `Brass.registerSerializer`.

Documents your app creates itself have no source file. If your app
only makes its own documents, it reads and edits records and declares a
schema so peers can open them.

## The record store

The record store is the same for every format. It lives at the
document root as two containers: `instances` (a map keyed by record id
`'#23'` whose values are `{ type, params }` records) and
`instance_order` (the same keys in file order, which the serializer
walks to re-emit the file). Every record in `instances` must have its
key in `instance_order`, or the serializer drops it.

**Reach for both as one handle:
`doc.orderedMap('instances', 'instance_order')`.** The ordered map
keeps the order list in step for you: an add appends the key, a delete
prunes it, both in one commit (one undo step). You never write
`instance_order` by hand.

```ts
const records = doc.orderedMap('instances', 'instance_order');

records.read();              // { '#1': { type, params }, ... }
records.get('#1');           // one record, or undefined
records.ordered();           // [{ key, value }, ...] in file order
records.keys();              // ['#1', '#2', ...] in file order

records.mutate((m) => {
  m[newKey] = { type, params };                // add: appended to order
  delete m['#7'];                              // delete: pruned from order
  m['#3'].params = [...];                      // field edit: order untouched
});
```

`type` is the format's record tag, and `params` is the record body, whose
shape is format-specific. Values read back are detached copies.

**Edit a record by reassigning its whole `params`.** The record is the
unit of change: the value you read back is a detached copy, so
mutating it element-wise does not persist. Build the new `params` and
assign it. Because edits live in the canonical store, the original
format re-emits faithfully on export.

**A newly added record lands at the end of source order.** When the
order is structural (a record must sit inside a section or a parent's
child range to re-emit validly), don't lean on physical record order:
have your serializer reconstruct the structure from the records' own
declared section / parent on the way out.

## Cost by change: subscribe, don't re-read

An imported model is commonly hundreds of thousands of records, so a
per-change `read()` to rebuild your view is O(file) per keystroke. The
subscription hands you a `change` on every fire: the first fire
carries the whole store as `change.set` (build your view there), and
every later fire names only the changed records (one path for your own
edits, remote edits, and post-open hydration alike). Don't memoise the
derivation on a record-count fingerprint: an in-place edit keeps the
count, so the memo reads back stale. And keep view-only changes (pan,
zoom, selection) off the content paint.

## How a format maps to records

Map every format to records by the same recipe, which is what lets
independently-built apps predict and share a format's records:

1. **One record per element the format enumerates as its own
   addressable item** (a STEP instance, an entity, a named element).
   Inline only anonymous leaf scalars that have no identity of their
   own. The record is the concurrent-edit unit: its whole `params`
   merges last-writer-wins, so keep `params` a small plain value and
   never pack several independently-edited values into one record.
2. **`type` is the format's own class tag, verbatim**: no renaming, no
   prefix.
3. **The key is the format's own stable id, verbatim.** When the
   format has no native id, synthesize one deterministically from the
   record's own content, never from its position in the file (a
   positional index is not stable across a re-import) and never at
   random.
4. **`params` is the object's own fields as a plain value**,
   reassigned whole to edit it.
5. **A relationship is its own record only when the format makes it an
   object**, and otherwise it stays a reference field, on the **child**
   pointing up to its parent. A mutable child-list on the parent is a
   concurrently-edited array, so two people adding different children
   collide.
6. **Decompose only what has a model.** Named objects shred into
   records; binary bulk is referenced by hash, not inlined; a file
   with no object model stays an opaque `brass:file` blob.

To build against a format someone else imported, read its schema: it
declares exactly how the importer encoded each field into `params`
(value shapes, the reference convention) in its `description`s. Get it
from the document's dashboard page (**Download brass-app.json**), and
declare that copy in `brass-app.json` to route those documents to your
app. See [`schemas.md`](./schemas.md).

## Registering your format's importer (`Brass.registerImporter`)

For a file kept as-is, register your parse half once at boot, and Brass
runs it when an import is needed:

```ts
Brass.registerImporter(async (src, doc) => {
  // src: { url, filename, content_type, byte_size, expires_in, streams }
  const bytes = new Uint8Array(await (await fetch(src.url)).arrayBuffer());
  const parsed = parseMyFormat(bytes); // your own parser
  const records = doc.orderedMap('instances', 'instance_order');
  records.mutate((m) => {
    for (const r of parsed) m[r.id] = { type: r.type, params: r.body };
  });
  await doc.createCheckpoint();
});
```

The importer receives the stored source file (a short-lived download
URL plus the file's name, type, and size, with the bytes not inlined)
and the open document, parses the bytes, and writes the records
through the ordinary handles. `DocumentImporter` types the callback.

Brass decides when an import is needed and runs your importer once. A
document that already holds its records, or has no stored file, is left
alone, and the records reach every open client through its normal
subscription. Declare the `schema` of the records your
importer writes in `brass-app.json`: importing publishes it and
stamps it on the document, so the document routes and resolves its
schema like any imported document.

Sealing the write with `doc.createCheckpoint()` at the end of the
importer makes the import one undo step, so an undo reverts it whole
instead of leaving a half-deleted model. An importer that throws
surfaces through `Brass.onError`, and Brass retries the import later.

**Spread a large format across streams.** When your format is large,
keep the records a default view reads in the default stream, and move
the bulk (geometry, an index most opens skip) onto streams you create. Name those streams in your schema's `streams`, and a reader
merges them the same way it merges any format's:

```ts
Brass.registerImporter(async (src, doc) => {
  const { structured, geometry } = parseMyFormat(await bytesOf(src));
  doc.orderedMap('instances', 'instance_order').mutate((m) => {
    for (const r of structured) m[r.id] = { type: r.type, params: r.body };
  });
  // A stream your schema names, so your serializer composes it back and
  // any app expecting it merges its records.
  const geom = await doc.getOrCreateStream('geometry');
  geom.orderedMap('instances', 'instance_order').mutate((m) => {
    for (const r of geometry) m[r.id] = { type: r.type, params: r.body };
  });
  await doc.createCheckpoint();
});
```

Name `geometry` under `streams` in the same schema you ship in
`brass-app.json`, so a reader can resolve its contract. A document can
also hold streams your schema does not name (a review overlay, a
computed cache), and your serializer composes only the streams it
declares, so those stay in the document and out of the file. Nothing
here is privileged: a document your importer spreads is
indistinguishable from one the platform produced, and every app that
declares the same streams reads it the same way. Your serializer
reassembles it by reading those same streams back
(`doc.stream('geometry')`).

`doc.sourceBlob()` is the same source-file read as the importer's
`src` argument, for code outside the importer that needs the original
bytes (a "view original" affordance). It rejects with a `BrassError`
for a document that has no stored original file.

A source file is a set of one or more byte streams: the primary stream
(what the filename names) plus any sidecar streams uploaded with it (a
glTF's `.bin` buffer, a shapefile's `.dbf`). `src.streams` lists every
stream, primary first, each as `{ name, url, content_type, byte_size }`
with its own download URL, so an app fetches exactly the streams it
needs, in parallel. A single-stream file has exactly one entry (it
mirrors the top-level fields), so code that iterates `streams` handles
both cases in one path:

```ts
const byName = new Map(src.streams.map((s) => [s.name, s]));
const buffer = byName.get('scene.bin'); // undefined when not part of the set
```

**Choose the record as the smallest thing two people edit
independently.** Concurrent edits to one record resolve
last-writer-wins on its whole `params`, so a grid of
independently-edited values is one record per cell (keyed by row and
column), not one record per row. Reconstruct rows for display and for
the serializer by walking the cell records. The same reasoning bans
nesting a collaboratively-edited array inside one record.

## Registering your format's serializer

Your serializer rebuilds the file from your records, and the platform
runs it for the download button and for drive publish. Write it as the
inverse of your importer so that it produces the format the importer
read. Register it once at boot, either before or after `Brass.init`:

```ts
Brass.registerSerializer((doc) => {
  const records = doc.orderedMap('instances', 'instance_order');
  const text = myFormatToText(records.ordered()); // inverse of your parser
  return new TextEncoder().encode(text);
});
```

The serializer takes the open `Document` and returns the bytes
(`Uint8Array`, or a promise of one). Producing the bytes is its only
job, and `DocumentSerializer` types the callback. With it registered, your
app only ever works with records, never with file I/O.

Your app exports so that software outside Brass can read its work. The
format therefore has to be one that software already opens. If your app
imports a file, write that same format back out. If your app makes its
documents from nothing, ask the people who use it which tool they need
the download to open in, and write that tool's format. A format you
invent yourself produces a file only your app can read, and apps inside
Brass already share documents through the schema you declare.

## Declaring what your app handles

Your app declares what it reads and writes in its capability manifest
at `/.well-known/brass-app.json`. `accepts` matches the uploaded files
you import, `exports` names the format you write back out, and `schema`
declares the records you work with. See
[`app-manifest.md`](./app-manifest.md).

An editor only needs to declare `opens`, and its copy of the format's
`schema` already does that. Brass delegates a document's import and
export to an installed app that handles the format, so your app reaches
the records without writing either half. Write your own importer and
serializer if you would rather not depend on another app being
installed, or if you need a format the installed apps do not handle.
