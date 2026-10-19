# Schemas

A schema declares what your app expects a document to contain. Declaring one
in your `brass-app.json` routes matching documents to your app, and lets
any developer who can open one of those documents build against the same
shape.

## Declaring a schema

A schema is a `family` and a `streams` map. Each entry is a plain
[JSON Schema](https://json-schema.org) (draft 2020-12) describing that
stream's root collections and records.

- **`family`** is a short word naming what the artifact is: the domain or
  standard it projects. Use the word the standards world already uses when
  there is one, and the domain's own word when there is not, so a CNC
  toolpath is `gcode` and a shift schedule is `roster`. It is the identity
  other apps converge on, so it names the artifact rather than your app or
  your version: `gcode`, not `acme-cam` and not `gcode-2`. Lowercase
  `a-z 0-9 . _ -`, up to 64 characters, the same rule a stream name follows,
  so a namespaced `acme.roster` works and a URL does not. Brass does not
  record a declaration whose family is missing or not a word, and reports
  that on your app's page in the dashboard.
- **`streams`** maps each stream name your app expects a document to have
  to that stream's contract. `default` is the stream a document opens
  without asking for one, and takes an entry like any other name. Two
  streams that carry the same shape carry the same body.
- **A collection of records** is an object whose `additionalProperties`
  is the record schema, so the keys are record ids. An ordered collection
  is an array, or an array of keys alongside the map.
- **A text root** (`doc.text(key)`) reads as a string wherever the
  document is read as data, `brass contents` included, so describe it as a
  string property of the stream: `{ "type": "string" }`.
- **Foreign keys** ride as an `x-brass-ref` extension on the referring
  field, an object whose `to` names the collection it points at.
  Standard validators ignore an `x-` keyword.
- **The `x-brass-` prefix is reserved for Brass.** Give your own extensions
  their own prefix (`x-acme-`), so a name you choose keeps its meaning when
  Brass defines a keyword later. A keyword in a pulled body describes the
  data rather than your app, so keep the body verbatim rather than dropping
  keywords you do not recognise.
- **`description`** carries the conventions structure cannot: an
  ordering, a unit, an invariant. Put it wherever the convention belongs.

Brass never keys on `$id`, and never enforces a schema against a
document. It validates that each body is well-formed JSON Schema when
your manifest is ingested, and nothing after that.

To work with documents that already exist, take their schema rather than
writing your own: open one in the dashboard and use **Download
brass-app.json**, or run `npx @brass-build/cli schema pull --doc <docId>`.
Keep it verbatim. Your copy is the contract your code is built against,
and an approximation reads as a different contract.

## Creating a stream

Streams let one document load in parts, so an app pays for what it opens
rather than the document's total size. `doc.getOrCreateStream(name)`
opens the document's stream of that name and makes it when the document
does not have it yet. `doc.stream(name)` opens one the document already
has and rejects any other name.

```ts
const stream = await doc.getOrCreateStream(name);
stream.map('records').mutate((m) => {
  m[id] = record;
});
```

`getOrCreateStream` is idempotent, and concurrent callers converge on one
stream, so an app reaches for the stream it expects on every open without
checking first. Only that call writes, so a read-only open reads through
`doc.stream` and handles the rejection when the document does not have
the stream. Names follow the same rule a family does: `a-z 0-9 . _ -`, 1 to
64 characters, starting with a letter or digit.

A separate stream suits records only some opens need to load, or that an
exporter should leave out. Name it in `streams` and its shape is
declared, so any app that expects it reads the same contract. See
[Streams](./streams.md) for partitioning, undo, and reading a document
spread across several.

## What an app can open

An app opens a document when they share a family and **everything the app
requires the document already guarantees.** That is the whole test, and
it runs per stream, over the streams both sides name. Your schema does
not have to match a document's exactly, only ask no more of it, so an
app opens documents written against shapes it was never built for.

An exporter composes the streams it declares, so an app exporting a
document writes the parts it knows about and leaves the rest. Two apps
can export the same document differently, each emitting what it
understands.

## What breaks compatibility

Because the test is about `required`, that is the only part of a schema
that can break anything.

- **Removing a required property breaks other apps.** Your documents stop
  guaranteeing that field, so apps requiring it stop opening them. Your
  own app keeps working, so you will not see it.
- **Adding a required property narrows what you can open**, since older
  documents never promised it.
- **Adding an optional property is safe** in both directions.

Keep records open (no `additionalProperties: false`) so your app
preserves fields it does not recognise rather than dropping them on
write, and handle a missing field gracefully, since Brass enforces
nothing and a writer may not have written it.

## Adding a required property anyway

Declare a `writes` map beside `streams` when the two sides differ. It
takes the same stream names and the same bodies, and it is what your app
guarantees when it writes, where `streams` is what it expects to read.

```json
{
  "family": "building",
  "streams": { "default": { "type": "object", "required": ["walls"] } },
  "writes": {
    "default": { "type": "object", "required": ["walls", "site"] }
  }
}
```

That app opens every document guaranteeing `walls`, including ones
written before `site` existed, and every document it saves guarantees
`site` as well. An app still on the old shape reads the result, because
the document now guarantees more than that app expects. Leave `writes`
out and one contract covers both sides, which is what most apps want.
