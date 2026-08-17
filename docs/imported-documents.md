# Handling a file format

A user uploads a file or opens a drive item, and Brass turns it into a
document your app opens like any other. What your app writes depends on
whether the format already has an importer.

**A format someone already imports.** The parsed records are the
document, and Brass re-emits the original on export and drive-push
through an installed app that serialises the format. Your app is an
editor: declare the document's schema in `brass-app.json` so peers can
open it, and read the records through the ordinary handle surface. See
[`schemas.md`](./schemas.md).

**Any other file.** The document is an opaque file (source `schema_type`
is `brass:file`) until your app parses it. Register the parse half with
`Brass.registerImporter` and the inverse with `Brass.registerSerializer`.

## Registering an importer

Register your parse half once at boot, and Brass runs it when an import
is needed:

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

The importer receives the stored source file (a short-lived download URL
plus the file's name, type, and size, with the bytes not inlined) and the
open document. `DocumentImporter` types the callback.

Brass decides when an import is needed and runs your importer once. A
document that already holds its records, or has no stored file, is left
alone, and the records reach every open client through its normal
subscription. Declare the `schema` of the records your importer writes in
`brass-app.json`: importing publishes it and stamps it on the document.

Sealing the write with `doc.createCheckpoint()` makes the import one undo
step, so an undo reverts it whole instead of leaving a half-deleted
model. An importer that throws surfaces through `Brass.onError`. Brass
retries an import that wrote no records. Once records are written, it
refuses a later import of that document, because running the importer
again over them would write each of those records twice.

Key each record by the format's own stable id. When the format has no
native id, derive one from the record's own content rather than from its
position in the file, which is not stable across a re-import.

## Reading the source bytes

A source file is a set of one or more byte streams: the primary stream
(what the filename names) plus any sidecar streams uploaded with it (a
glTF's `.bin` buffer, a shapefile's `.dbf`). `src.streams` lists every
stream, primary first, each as `{ name, url, content_type, byte_size }`
with its own download URL, so an app fetches exactly the streams it
needs, in parallel. A single-stream file has exactly one entry, so code
that iterates `streams` handles both cases in one path:

```ts
const byName = new Map(src.streams.map((s) => [s.name, s]));
const buffer = byName.get('scene.bin'); // undefined when not part of the set
```

`doc.sourceBlob()` is the same read for code outside the importer that
needs the original bytes (a "view original" affordance). It rejects with
a `BrassError` for a document that has no stored original file.

## Registering a serializer

Your serializer rebuilds the file from your records, and the platform
runs it for the download button and for drive publish. Write it as the
inverse of your importer. Register it once at boot, either before or
after `Brass.init`:

```ts
Brass.registerSerializer((doc) => {
  const records = doc.orderedMap('instances', 'instance_order');
  const text = myFormatToText(records.ordered()); // inverse of your parser
  return new TextEncoder().encode(text);
});
```

The serializer returns the bytes (`Uint8Array`, or a promise of one).
`DocumentSerializer` types the callback. It runs detached, with no
subscription feeding it, so the document it is handed reads its
containers whole: `StoredDocument` types that document, and its `map` /
`list` return a `StoredMap` / `StoredList`, which add `read()` to the
handle an app holds.

Your app exports so that software outside Brass can read its work, so
write a format that software already opens. If your app imports a file,
write that same format back out. If your app makes its documents from
nothing, ask the people who use it which tool they need the download to
open in, and write that tool's format.

## Declaring what your app handles

Your app declares what it reads and writes in its capability manifest at
`/.well-known/brass-app.json`. `imports` matches the uploaded files you
import, `exports` names the format you write back out, and `schema`
declares the records you work with. See
[`app-manifest.md`](./app-manifest.md).

An editor only needs to declare `opens`, and its copy of the format's
`schema` already does that. Brass delegates a document's import and
export to an installed app that handles the format, so your app reaches
the records without writing either half. Write your own importer and
serializer if you would rather not depend on another app being
installed, or if you need a format the installed apps do not handle.
