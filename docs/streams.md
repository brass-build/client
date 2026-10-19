# Streams: loading a document in parts

A document is a container of **streams**: named units of document
state that load independently. Opening a document costs only the
streams your app touches, so download, load, and memory scale with what
the app reads rather than with the document's total size. Every stream
is live, collaborative state that merges the same way the rest of the
document does.

The app or importer that writes a document decides its streams. Your
app can put a heavy part of its content (a terrain mesh, a point-cloud
index, a layer only some views draw) in a stream of its own, and an open
that does not ask for that stream never downloads it. Your app can also
keep records about a document (clash findings, review notes, a cache of
derived results) in a stream beside the document's content, so they sync
and version with it and stay out of an exported file unless the exporter
declares that stream. An
importer can split a model the same way: with its geometry in a stream
of its own, a property editor opens only the default stream, and a 3D
viewer opens only the geometry.

Every document has a stream named **`default`**, and an open that names
no stream opens that one, so the doc-level handles (`doc.map(...)`,
`doc.orderedMap(...)`) read it. A document with one stream keeps all of
its content there. Name another stream on the open (below) and the
doc-level handles read that one instead.

## Opening and editing a stream

```ts
const stream = await doc.stream(name);
const records = stream.orderedMap('instances', 'instance_order');
records.mutate((m) => {
  m[id] = { type, params };
});
records.subscribe((change) => render(change));
```

`doc.stream(name)` resolves once per name: the first call downloads the
stream's snapshot and subscribes it live, and repeat calls return the same
open. It only reads, so it rejects a name the document does not have.
To make a stream, see [Adding a stream](#adding-a-stream). A
`DocumentStream` has the same read and write methods as the document,
scoped to that stream: `map` / `list` / `orderedMap` handles, `mutate`,
and `subscribe`.

## Opening at a stream

`Brass.openDocumentById(docId, { stream })` opens the document with that
stream as its own state, so `doc.map(...)` hands you its records and the rest
of the document is never downloaded. A 3D viewer of an imported model
opens at `geometry` and downloads nothing else:

```ts
const doc = await Brass.openDocumentById(docId, { stream: 'geometry' });
doc.orderedMap('instances', 'instance_order').subscribe((change) => {
  for (const [key, record] of change.set) draw(key, record); // geometry records
});
```

`stream` defaults to `'default'`, the stream every document has, so an
open always names a stream and the usual one needs no argument.
`doc.stream(name)` resolves the name the document was opened at back to
the document itself, with no second join, and any other name to its own
stream, so the loop below reads the same whichever stream you opened at:

```ts
for (const info of await doc.listStreams()) {
  const stream = await doc.stream(info.name);
  stream.map('instances').subscribe((change) => summarize(change.set));
}
```

## Adding a stream

`doc.getOrCreateStream(name)` opens the document's stream of that name,
and creates it if the document does not have it yet. A stream your app
adds syncs and versions with the rest of the document, and only the
opens that ask for it download it. Your app can add a stream to any
document the user can edit, including a file an importer or another app
made. The call is idempotent, and
concurrent callers get the same stream, so your app can call it on
every open without checking first:

```ts
const findings = await doc.getOrCreateStream('clash-findings');
findings.map('findings').mutate((m) => {
  m[id] = { elements: [a, b], status: 'open' };
});
```

Your app can add a stream to any document it can edit, including one
that another app created or imported. When the document already has a
stream of that name, such as one its importer wrote, `getOrCreateStream`
opens that stream instead of making a new one. Name the streams your app
adds after your app (`acme-clash-findings`) rather than after their
content, so your app does not write into a stream that another writer
named first.

Names are `a-z 0-9 . _ -`, 1 to 64 characters, starting with a letter or
digit, the same rule a schema family follows. `default` is a valid name
too: every document already has it, so `getOrCreateStream` resolves it
like any existing name, and a loop over the names your schema declares
needs no case for it. `getOrCreateStream` writes, so on a read-only
open, read with `doc.stream` instead, and render a reduced view when the
document does not have the stream.

## Undo and editing model

Each stream is its own collaborative unit: concurrent edits merge per
stream. One Undo reverts the whole step even while a collaborator edits
the same stream, and a map or text handle's `subscribe` fires once for
each commit the step took, each with `origin.source` `'undo'` (or
`'redo'`). A write your app makes on its own, such as the results of a
pass over other documents, passes `{ undoable: false }` to `mutate` so
the user's Undo skips it.

A stream that reaches the largest size Brass keeps stops taking writes on
its own: `stream.readOnly` and `stream.atCapacity` read `true`, and the
document's other streams keep taking writes. The edit Brass refused stays
on screen until your app opens the stream again, which loads what Brass
saved. Read `stream.atCapacity` to stop offering bulk work on that stream.

## When to add a stream

Opening a stream incurs a snapshot request, and opening the first stream
on a document also retrieves the stream manifest. Add a stream when
specific workflows can skip its content (such as a model's geometry, a heavy
layer, or tool-specific data). Partition content by what each workflow loads,
rather than by conceptual divisions. Aim for a handful of streams
carrying several megabytes each. Opening dozens of tiny streams is slower than
loading a single stream, and data required across every workflow belongs in
the default stream.

## Reading a document spread across streams

Your schema names the streams it expects a document to be spread over,
under `streams`. A small document keeps every record in its default
stream; a large one moves the bulk (a model's geometry, an index most opens
skip) onto the streams the schema names, so an app that reads only part of
the content loads only that part. The declaration is the same either way,
because it says which streams your app expects, not what any one document
turned out to contain.

Open only the streams that contain the records your app needs. The SDK
downloads and decodes each stream you open in full, so a property editor
over a model whose geometry has its own stream opens the default stream
alone.

If your app follows references into records in another stream (a
viewer resolving an element's shape, a clash check reading bodies), open
every stream the document has, because a referenced record can be in any
of them. `doc.listStreams()` lists them, so open them together and merge the
records by id:

```ts
import type { OrderedMapHandle } from '@brass-build/client';

type StoredRecord = { type: string; params: unknown };
const store: Record<string, StoredRecord> = {};

const streams = await Promise.all(
  (await doc.listStreams()).map((info) => doc.stream(info.name)),
);
const handles: OrderedMapHandle<StoredRecord>[] = streams.map((s) =>
  s.orderedMap<StoredRecord>('instances', 'instance_order'),
);
for (const records of handles) {
  records.subscribe((change) => {
    for (const [key, record] of change.set) store[key] = record;
    for (const key of change.deleted) delete store[key];
  });
}
// store['#137'] resolves wherever #137 lives.
```

This reads a document with one stream the same way it reads one with
several, so it needs no special case.

### Knowing when every stream has arrived

A handle's `onSettled` callback fires when that one container has arrived
whole. A conclusion drawn across several streams (a model with no
geometry, a count, "no run yet") is true only after every stream it reads
has settled. Until your app opens a stream, its records are unknown, not
empty. Render such a conclusion once every handle has settled, and show
the loading state until then:

```ts
const unsettled = new Set(handles);
for (const records of handles) {
  records.onSettled(() => {
    unsettled.delete(records);
    if (unsettled.size === 0) render(store);
  });
}
```

`onSettled` fires again when a version checkout replaces a container, so
`render` runs again for the version the user switched to. The same
applies to streams your app adds (findings, review notes). Open the ones
the document has alongside the rest, and treat their records as unknown
until their handles settle.

A document can have streams your schema does not name (computed results,
review notes, a cache). An exporter writes nothing from a stream it does
not declare. Read the streams your schema names, and the others only
when you follow references into them. `doc.getOrCreateStream` makes a
stream your schema names when the document does not have it yet.

## Exporting across streams

A registered serializer receives the live document and opens streams
like any other code, so an exporter collects from wherever the content
lives:

```ts
Brass.registerSerializer(async (doc) => {
  const names = new Set((await doc.listStreams()).map((s) => s.name));
  const geometry = names.has('geometry')
    ? (await doc.stream('geometry'))
        .orderedMap('instances', 'instance_order')
        .entries()
    : [];
  return encodeMyFormat(
    doc.orderedMap('instances', 'instance_order').entries(),
    geometry,
  );
});
```

Collect everything from the document itself. Brass may run your
serializer detached from your app (a dashboard download, or a drive
publish with your app not open), so open the streams you need rather
than reach for your app's UI state.
