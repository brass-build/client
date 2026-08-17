# The capability manifest (`brass-app.json`)

Every app ships a `brass-app.json`, and the platform reads it to decide
where your app shows up. Brass adds an "Open in" link to a document
card, offers your app when someone uploads a file it handles, and shows
a download button on the documents your app writes out.

## Where it goes

Put `brass-app.json` in a `/.well-known/` directory at your bundle
root, next to `index.html`. Some bundlers skip dot-directories when
they copy static assets, so confirm the manifest is in your `dist/`
directory after you build.

The platform re-reads the manifest after each deploy, so publishing
your bundle is what registers it. If Brass hosts your bundle
(`brass publish`), it reads the manifest from the bytes it stores, so
your capabilities register even when your load gate is on. If you serve
the bundle from your own origin, the platform fetches
`<origin>/.well-known/brass-app.json` as an anonymous client, so serve
that path publicly even when the rest of your app requires sign-in.

The `opens` and `creates` tokens below only drive discovery and grant
no access, so you declare them yourself.

## What goes in it

```json
{
  "opens": ["tracker"],
  "imports": [{ "extension": "csv" }, { "content_type": "text/csv" }],
  "creates": "tracker",
  "exports": { "content_type": "text/csv", "file_extension": ".csv" },
  "icon": "/icon.svg",
  "schema": { "...": "see schemas.md" }
}
```

Every field is optional, so ship only the ones your app uses.

- **`opens`** lists the `schema_type`s of documents your app reads.
  Declaring a `schema` already folds its family in, so most apps list
  nothing extra here.
- **`imports`** matches an uploaded file by extension or content type,
  so Brass offers your app to whoever uploads one. Your app then reads
  the file's bytes through `sourceBlob()`.
- **`creates`** is the `schema_type` Brass stamps on the documents your
  app makes, so peer apps that declare `opens` for the token can open
  them. It folds into your own `opens` as well.
- **`exports`** names the file format your app writes a document out
  to, and your `Brass.registerSerializer` callback produces the bytes.
  Declaring it makes those documents downloadable. Declare it when your
  app interoperates with a format outside Brass.
  [`imported-documents.md`](./imported-documents.md) covers how an
  importing app chooses that format.
- **`icon`** points at your app's mark, which the platform renders on
  your app's tiles and on the hosted consent screen when someone grants
  your app access. Draw a small SVG and serve it from your own bundle
  (`"icon": "/icon.svg"`, resolved against your origin), or give an
  absolute `https://` URL. An emoji (`"icon": "🏗️"`) also renders,
  though apps in one domain tend to land on the same few.
- **`schema`** declares the record shape your app works with, whether
  you invented it or adopted an existing one. See
  [`schemas.md`](./schemas.md).
