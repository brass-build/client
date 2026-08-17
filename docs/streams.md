# Streams: partitioning a document for lazy loading

A document is a container of **streams**: named units of document
state that load independently. Opening a document costs only the
streams your app touches, so download, load, and memory scale with what
you use rather than with the document's total size. Split a
multi-discipline design into architectural, plumbing, HVAC, and
structural streams, and a plumbing tool opens one of them. Every stream
is live, collaborative state that merges the same way the rest of the
document does.

Every document has a stream named **`default`**, and an open that names
no stream opens that one, so the doc-level handles (`doc.map(...)`,
`doc.orderedMap(...)`) read it. An unpartitioned document is one whose
content lives entirely there. Name another stream on the open (below)
and the doc-level handles read that one instead.

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
open. It only reads, so a name the document does not hold rejects rather
than being created. `doc.getOrCreateStream(name)` is the call that makes
one. It is idempotent and concurrent callers converge on one stream, so an
app reaches for the stream it expects on every open without checking
first. A `DocumentStream` carries the document's own reading and writing
surface scoped to that stream: `map` / `list` / `orderedMap` handles,
`mutate`, `subscribe`, and `undo` / `redo`.

## Opening at a stream

`Brass.openDocumentById(docId, { stream })` opens the document with that
stream as its own state, so `doc.map(...)` hands you its records and the rest
of the document is never downloaded. An app that works in one part of a large
document pays for that part alone:

```ts
const doc = await Brass.openDocumentById(docId, { stream: 'hvac' });
doc.orderedMap('instances', 'instance_order').subscribe((change) => {
  for (const [key, record] of change.set) hold(key, record); // hvac's records
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

Names are `a-z 0-9 . _ -`, 1 to 64 chars, starting with a letter or
digit, the same rule a schema family follows. `default` is one of them:
every document already holds it, so `getOrCreateStream` resolves it
without a request, and a loop over the names your schema declares needs
no case for it. `getOrCreateStream` writes, so a read-only open reads
with `doc.stream` instead and shows a degraded view when the document
does not hold the stream.

## Undo and editing model

Each stream is its own collaborative unit: concurrent edits merge per
stream, and each stream keeps its own local undo stack
(`stream.undo()` / `stream.redo()`). The doc-level `doc.undo()` covers
only the default stream.

A stream's local edits group into one undo step until the group is
**sealed** with `stream.sealUndoStep()`, the same same-stroke
collapsing doc-level undo gets from checkpoints. Seal when a user
operation completes. An app that never seals gets one giant step per
session.

### Undoing an operation that spans streams

When one user action writes to several streams (move a wall in
`architectural`, reroute its duct in `hvac`), keep an app-level
operation journal and undo each touched stream once per journal entry.
Two rules make the stacks line up:

1. **Seal every touched stream when the operation completes.** The
   seal is what makes the operation exactly one undo step in each
   stream, however many mutates it took.
2. **Route every local edit through the journal.** The alignment
   argument is LIFO: if every operation is journaled and sealed, each
   stream's stack top always belongs to the most recent journaled
   operation that touched it. An edit that bypasses the journal
   breaks that.

```ts
import type { DocumentStream } from '@brass-build/client';

type Op = { label: string; streams: string[] };
const undoJournal: Op[] = [];
const redoJournal: Op[] = [];

// Wrap every user operation: run the writes, then seal + journal.
async function operation(
  label: string,
  streams: string[],
  run: (open: Map<string, DocumentStream>) => void,
) {
  const open = new Map(
    await Promise.all(
      streams.map(async (n) => [n, await doc.stream(n)] as const),
    ),
  );
  run(open);
  for (const s of open.values()) s.sealUndoStep();
  undoJournal.push({ label, streams });
  redoJournal.length = 0; // a fresh edit clears redo, as usual
}

await operation('Move wall', ['architectural', 'hvac'], (open) => {
  open.get('architectural')!.map('instances').mutate((m) => {
    /* move the wall */
  });
  open.get('hvac')!.map('instances').mutate((m) => {
    /* reroute the attached duct */
  });
});

async function undoOperation() {
  const op = undoJournal.pop();
  if (!op) return;
  // Reverse application order, so dependent changes unwind last-first.
  for (const name of [...op.streams].reverse()) {
    (await doc.stream(name)).undo();
  }
  redoJournal.push(op);
}

async function redoOperation() {
  const op = redoJournal.pop();
  if (!op) return;
  for (const name of op.streams) {
    (await doc.stream(name)).redo();
  }
  undoJournal.push(op);
}
```

Bind your keyboard shortcut and undo button to `undoOperation()`
rather than `doc.undo()` (which covers only the default stream).
Collaborators' edits do not disturb the alignment: undo stacks are
local-peer-scoped, and each stream's undo rebases your reverted step
over remote changes the same way single-document undo does.

Design around two properties of it. The cross-stream undo is **not
atomic**: each stream's revert is its own commit, so a collaborator can
briefly observe one stream reverted before the other (the same window
any multi-stream operation has). And the journal is **in-memory**: a
reload starts it empty, exactly like single-document undo. When an
operation cannot tolerate that window, its data belongs in one stream:
partition by load unit, and keep records that must change together in
the same stream.

## When to partition

Opening a stream costs a request for its snapshot, and the first one on a
document also reads the stream manifest, so add a stream when it carries
real content that some opens can skip. Partition by **load unit** (a
discipline, a heavy layer, a dataset a specific tool reads), not by
concept. Aim for a handful of streams carrying megabytes each. Dozens
of tiny streams make opening everything slower than a monolith, and
content every open needs belongs in the default stream.

## Reading a document spread across streams

Your schema names the streams it expects a document to be spread over,
under `streams`. A small document keeps every record in its default
stream; a large one moves the bulk (an IFC's geometry, an index most opens
skip) onto the streams the schema names, so an app that reads only part of
the content loads only that part. The declaration is the same either way,
because it says which streams your app expects, not what any one document
turned out to hold.

If your app follows references between records, read every stream the
DOCUMENT holds, because a referenced record may live in one the default
stream does not. `doc.listStreams()` is that list, so merge by id:

```ts
import type { OrderedMapHandle } from '@brass-build/client';

type StoredRecord = { type: string; params: unknown };
const store: Record<string, StoredRecord> = {};
const fold = (records: OrderedMapHandle<StoredRecord>) =>
  records.subscribe((change) => {
    for (const [key, record] of change.set) store[key] = record;
    for (const key of change.deleted) delete store[key];
  });

fold(doc.orderedMap<StoredRecord>('instances', 'instance_order'));
for (const info of await doc.listStreams()) {
  const stream = await doc.stream(info.name);
  fold(stream.orderedMap<StoredRecord>('instances', 'instance_order'));
}
// store['#137'] resolves wherever #137 lives.
```

The loop reads an unpartitioned document the same way it reads a split
one, so it needs no special case. Open only what you read: an app that
needs just the default view's records reads the default stream alone,
and one that resolves references reads them all and pays for the
streams it opens.

A document can hold streams your schema does not name (computed results,
review notes, a cache), so the merge above skips them and an exporter that
does not declare them writes nothing from them. Name a stream in your
schema to read it, and `doc.getOrCreateStream` makes it when the document
does not hold it yet.

## Exporting across streams

A registered serializer receives the live document and opens streams
like any other code, so an exporter collects from wherever the content
lives:

```ts
Brass.registerSerializer(async (doc) => {
  const arch = await doc.stream('architectural');
  const hvac = await doc.stream('hvac');
  return encodeMyFormat(
    arch.orderedMap('instances', 'instance_order').ordered(),
    hvac.orderedMap('instances', 'instance_order').ordered(),
  );
});
```

Collect everything from the document itself. Brass may run your
serializer detached from your app (a dashboard download, or a drive
publish with your app not open), so open the streams you need rather
than reach for your app's UI state.
