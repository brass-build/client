# Changelog

All notable changes to `@brass-build/client` are recorded here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the package follows [semantic versioning](https://semver.org/spec/v2.0.0.html).
While the version is below `1.0.0`, minor releases may introduce
breaking changes.

## 0.4.0

### Added

- Call a third-party API without your app ever holding its credential.
  Declare the host under `services` in `brass-app.json`, and
  `Brass.callService(host, path, options)` adds the credential and returns the
  service's response unchanged. `Brass.listServices()` reports which hosts
  have a credential (`ready`) and which of the rest the person using your app
  can connect (`connectable`), so you can show, offer or hide a feature before
  anyone clicks it, and `Brass.connectService(host)` opens the dialog that
  collects a missing one. See [`docs/services.md`](./docs/services.md).
- `doc.text(key)` stores text that several people edit at once, keeping every
  edit rather than the last one written. Its subscriber gets the same `origin`
  argument a map subscriber gets, and `PresenceState.textCaret` reports where
  each person's caret is. See
  [`docs/text-fields.md`](./docs/text-fields.md).
- `Brass.init` accepts `undefined` as the app id, so one bundle works both on
  a Brass-hosted origin, which supplies the id, and on your own, which does
  not: `Brass.init(import.meta.env.VITE_BRASS_APP_ID)`.

### Removed

- The `@brass-build/client/vite` subpath and its `brassVite()` plugin. The SDK
  loads its WebAssembly engine with no build-time configuration, so `vite
  build` and webpack need nothing. Vite's dev server needs
  `optimizeDeps: { exclude: ['@brass-build/client'] }` in its config. See the
  README's "Modules and assets".

### Fixed

- A document that cannot reach Brass reports the failure instead of accepting
  edits it cannot save. The first write calls `Brass.onError` and sets
  `doc.readOnly`, and a later `mutate` throws. Disable your editor on
  `doc.readOnly`.
- Reopening a document whose import did not finish runs the import again.
- A `doc.stream(name)` open that fails closes its connection, instead of
  leaving it open for the life of the page.
- A stream that reaches the platform's size ceiling goes read-only and reports
  `stream.atCapacity`, rather than alerting the reader and reloading the whole
  document a stream is only part of. The rest of the document keeps taking
  writes; disable the stream's own bulk work on `stream.atCapacity`.
- Escape closes only the topmost hosted dialog. A toolbar command opened over
  a picker used to report a dismissal to both.
- A hosted dialog on a slow connection no longer navigates the page away to
  the standalone picker.
- A page whose signed-in user changes forgets the previous user's last
  selection, instead of opening their document for the new one.

## 0.3.0

### Added

- Imported documents generate a thumbnail on first open. Apps already calling
  `useCanvas` need no change.
- Documents can be published into a connected project's drive, creating the
  file there. Apps already mounting `Brass.mountDriveSync` get the action.
- `doc.driveStatus.sourceUnreadable` carries the drive's own words when it
  received a file it cannot read.

## 0.2.0

### Added

- Large collections page themselves. A map an app fills past 5,000 records
  stores them in compressed pages instead of one container per record, which
  keeps a bulk write and a reload viable at hundreds of thousands of records.
  `get()`, `has()` and `mutate()` read and edit a paged map exactly as they do
  a small one.
- A map keeps its own bookkeeping beside your records, under keys beginning
  with `brass:`, so a write under one of those keys is refused. Any other key
  is yours.
- `doc.atCapacity` (and `stream.atCapacity`) reports that the platform has
  refused a write because the document reached its ceiling. A document gets
  there through a band where ordinary editing still lands and a bulk write is
  refused, so this is the signal to stop offering the bulk work (an import, a
  generate pass) while leaving the rest of the app alone. Edits keep applying
  to the local copy while it reads `true`, so an app can show the reader what
  they did alongside the fact that it is not saved. `doc.subscribe` fires when
  it flips, once rather than once per refused change.
- `onSettled(cb)` on the map, list and ordered-map handles fires when a
  delivery of the whole collection finishes, so the work that follows on the
  collection (framing the camera on what arrived, a first pass over it) has
  somewhere to live other than a single change.
- `orderedMap.insert(key, value, at)` and `orderedMap.move(key, to)` place and
  reposition an entry against a neighbour, through the new `OrderedMapPosition`
  type.
- A list draft carries `move(from, to)`. Two people repositioning the same
  entry with it converge on one entry, where a removal paired with an
  insertion keeps both insertions and leaves the entry in the list twice.
- Presence layers carry a 2,048-byte cap (`PRESENCE_LAYER_MAX_BYTES`). Watch
  `presence.onStatus` to know when Brass is withholding a layer that is over
  it; a `selection` crosses the cap at roughly 130 to 140 typical entity ids,
  so publish a bounded summary when a selection can get large.
- The browser's own "leave site?" prompt appears while a document holds edits
  the server has not acknowledged, so a reload cannot silently drop them.

### Changed

- `session.status` reaches `error` for a file Brass could not prepare, on top
  of a deleted or inaccessible document. One error screen still covers them
  all.
- `doc.readOnly` now also reads `true` for a document that could not be
  loaded, so edit affordances gated on it stay disabled there as well as
  during loading.
- A store pages at 5,000 records rather than 50,000, where paging starts
  paying for itself: it writes about 3x faster, opens about 5x faster and
  stores about 1.7x smaller. What it costs is merge granularity. Below the
  threshold two people editing different fields of one record both keep their
  edit; above it the record is the merge unit, so one of the two wins.
- Two tabs of one app are two claimants for an import, so only one of them
  parses the file.
- A list subscriber receives the splices its change made, applied in the order
  they arrive, so a render costs what the change carried rather than what the
  list holds.
- `SyntheticSubscribeEvent` names a move through version history `history`
  rather than `checkout`. `ChangeSource` no longer lists it: a version move
  swaps the whole container instead of writing into it, so it reaches a handle
  subscriber as a whole-container fire with no origin, and `doc.subscribe` is
  where that move is reported.
- A `Document` is reached through `Brass.session`, `Brass.openDocumentById`, or
  `Brass.createDocument`. The class no longer constructs.
- The capability manifest names the files an app imports under `imports`,
  which is the word the platform and the dashboard use for them.

### Removed

- `read()` on the map, list and ordered-map handles. A handle feeds an app
  through `subscribe`, which costs what a change carried rather than what the
  document holds, so a collection large enough to page never pays an
  O(document) walk to render. A registered serializer runs detached with no
  subscription behind it, and is handed a `StoredMap` / `StoredList` that
  keeps `read()`.
- The barrel no longer exports plumbing types that no `Brass`, `Document`, or
  `DocumentSession` member names: `AcquireOrganizationResult`,
  `HostedUiLauncher`, `HostedUiLauncherOptions`, `DocumentSessionDeps`,
  `StreamRuntime`, `CreateDocumentFn`, `DocumentFactory`,
  `DocumentAtVersionResponse`, `DocumentSnapshotResponse`,
  `DocumentDriveSummaryWire`, `OpenDocumentFactoryOptions`,
  `OpenDocumentByIdFn`, and `OpenDocumentWsClient`. What autocomplete offers
  is now what an app can call.
- `doc.pushToDrive` and `doc.resolveDrive` are internal. Publishing a document
  back to its drive source, and resolving a diverged one, are the hosted
  toolbar's controls. `doc.driveStatus` still reports the sync state, so an
  app can tell the reader they have unpublished edits.

## 0.1.0

Initial public release. The SDK turns a document into a live,
multi-user, persistent workspace: sign-in, the hosted file toolbar, and
a subscribe-render-mutate loop per open document. Ships as an ESM-only
package.
