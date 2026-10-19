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

**Any other file.** Nothing imports the file until your app registers an
importer for its type. Register the parse half with
`Brass.registerImporter` and the inverse with `Brass.registerSerializer`.

## Registering an importer

Register your parse half once at boot, and Brass runs it when an import
is needed. Call `Brass.registerImporter` at startup, unconditionally: not
after sign-in, and not after a document opens. Brass may load your app only
to run its importer, in a page where nobody signs in and no document opens,
and an importer registered behind either step is never registered there.

```ts
Brass.registerImporter(async (file) => {
  const parsed = parseMyFormat(await file.bytes()); // your own parser
  const instances: Record<string, unknown> = {};
  for (const r of parsed) instances[r.id] = { type: r.type, params: r.body };
  return {
    streams: {
      default: { instances, instance_order: parsed.map((r) => r.id) },
    },
  };
});
```

The importer takes a file and returns JSON, so a test can call it
directly with a file the test builds. `DocumentImporter` types the
callback, `ImportFile` types the file it receives (`name`,
`content_type`, `byte_size`, and `bytes()`, which fetches the file), and
`ImportResult` types what it returns.

`streams` is the document's content, keyed by stream name. The
document opens on `default`. Your app opens any other stream with
`doc.stream(name)`, so put content there that a user can skip while
reading the rest (a heavy geometry layer beside the elements). Each stream
is a JSON object whose top-level values are objects, arrays, or strings. A
stream name uses lowercase letters, digits, `.`, `-`, and `_`. The
`schema` in your `brass-app.json` describes this shape, and
`npx @brass-build/cli contents --doc <docId>` writes the content of a
document your importer produced to `contents.json` (`--stdout` prints it
instead).

Brass decides when a document needs an import and runs your importer
once. Every client with the document open then receives the whole result
together. Declare the `schema` of the records your importer returns in
`brass-app.json`. The import publishes that schema and stamps it on the
document.

When your importer throws, or returns no streams or only empty
collections, Brass reports the error through `Brass.onError`. Brass also
records the failure on the document and does not run your importer on
that file again until the file changes. Everyone who opens the document
sees your error's message after your app's name, so write it for that
user: "Row 3 has no date column" rather than a stack trace.

Key each record by the format's own stable id. When the format has no
native id, derive one from the record's own content rather than from its
position in the file, which is not stable across a re-import.

## Reporting what the import skipped or assumed

When your importer reads only part of a file, return an `ImportReport`
beside the streams that says what it left out and what it filled in.
Brass stores the report with the import and shows it, in your words, on
the document's page:

```ts
Brass.registerImporter(async (file) => {
  const rows = parseCsv(new TextDecoder().decode(await file.bytes()));
  const content = rowsToContent(rows); // your own mapping
  const findings: ImportFinding[] = [];
  if (rows.ragged > 0) {
    findings.push({
      kind: 'skipped',
      message: `Skipped ${rows.ragged} rows with more fields than the header.`,
    });
  }
  if (!rows.delimiterDeclared) {
    findings.push({
      kind: 'assumed',
      message: 'The file does not say how its fields are separated, so commas were used.',
    });
  }
  return findings.length > 0
    ? { streams: { default: content }, report: { summary: `Read ${rows.length} rows.`, findings } }
    : { streams: { default: content } };
});
```

`summary` is one optional sentence stating what the import read, which Brass
shows above the findings.

Each finding's `message` is one sentence, and the user sees it as you
wrote it. Its `kind` says what the sentence describes:

- `skipped` is content in the file that the import did not read.
- `assumed` is a value the file did not give, which the import supplied.
- `missing` is something the file names that did not arrive (a texture a
  model refers to, a drawing it references).

Return a report only when your importer has findings. Report only what
your importer can establish from the file, and do not tell the user a
file was read completely when the format cannot confirm it.

An app reads an open document's report from `doc.importReport` (`null`
when there is none), whichever importer wrote it. A `skipped` or `missing` finding means the document
contains only part of its file. An `assumed` finding means the importer
supplied some of the document's values rather than reading them from the
file.

## Reading the source bytes

Code outside the importer that needs the original bytes (a "view
original" affordance) calls `doc.sourceBlob()`. It resolves the stored
file as `{ url, filename, content_type, byte_size }`, where `url` is a
short-lived download URL. It rejects with a `BrassError` for a document
that has no stored original file.

## Registering a serializer

Your serializer rebuilds the file from your records, and the platform
runs it for the download button and for drive publish. Write it as the
inverse of your importer. Register it once at boot, either before or
after `Brass.init`:

```ts
Brass.registerSerializer((doc) => {
  const records = doc.orderedMap('instances', 'instance_order');
  const text = myFormatToText(records.entries()); // inverse of your parser
  return new TextEncoder().encode(text);
});
```

The serializer returns the bytes (`Uint8Array`, or a promise of one).
`DocumentSerializer` types the callback. It receives the same document
your app reads, and walks each container with `entries()` or `values()`.

Your app exports so that software outside Brass can read its work, so
write a format that outside software already supports. If your app imports a file
format, export that same format back out. If your app creates documents from
scratch, determine which formats users need to open in outside tools and export
that format.

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
