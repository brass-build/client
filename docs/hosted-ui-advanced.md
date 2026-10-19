# Hosted UI: advanced

Brass owns some surfaces: you call one method and Brass renders the UI
in a modal iframe over your page. `Brass.session` runs the common ones
(`history`, `share`, `manage`) behind the file menu. This page covers
the rest and how they behave in browsers that block the iframe.

## Surfaces

| Method | Returns |
| --- | --- |
| `Brass.shareDocument(docId)` | `Promise<void>`: opens the hosted share dialog for the document. |

## Narrowing a choice to the files you need

`Brass.chooseInputs(families, options?)` is how a user chooses files,
folders and projects for your app to read (see the README). `accept`
narrows the files of those families, for one call, by name or extension. Pass it once your app knows which files it
needs. An app that has just parsed a federation file asks for the models
that file names:

```js
await Brass.chooseInputs(['ifc'], {
  prompt: `Models in ${federation.name}`,
  accept: { names: federation.modelFileNames },
});
```

The picker renders `prompt` as a subtitle beneath its title. Pass a prompt
when narrowing the list with `accept`, explaining why only specific files appear.
On a request you do not narrow, omit the prompt as the picker already shows
all documents your app can open.

`names` matches both the document's name and the original filename it was imported
from, and `extensions` matches either name's extension. A document in the specified
families passes when it matches any given name or extension. When a user selects a
folder or project, this filtering persists, so listing the container returns only
the matching documents.

Version history is a built-in file-menu command (`history` in
`session.commands` and the SDK toolbar's file menu) rather than a
launcher method, so an app on `mountToolbar` or `mountFileMenu` gets it
with no code.

## Redirects in browsers that block the iframe

Where the browser blocks the Hosted UI iframe (Safari, Firefox, Chrome
with third-party cookies off), these surfaces open as a full-page
redirect to Brass and return to your app when the user is done. The
Open picker (`Brass.session.open()`) returns with the chosen document
opened into `Brass.session`.

So render the active document from the session (or `mountToolbar`): on
the redirect path the page reloads, so the code after `await
Brass.session.open()` never runs, and the picked document opens into the
session on reload instead.

`chooseInputs` and `chooseInput` do not redirect. Where the browser blocks
their iframe they reject with a `BrassError` whose `code` is
`'iframe_unavailable'`. Show the error's `message` and keep the references
your app already has.

## `BrassError` `.code` values

The hosted-UI launchers reject with `BrassError` carrying a `.code`
(rather than the `.status` the HTTP namespaces set):

- `'embed_error'`: the hosted page loaded but couldn't proceed (e.g.
  the user isn't signed in to Brass in this context).
- `'not_in_browser'`: called outside a browser environment.
- `'iframe_unavailable'`: the browser blocked the iframe and the surface
  has no redirect to fall back on (`chooseInputs`, `chooseInput`).

## Theming

Hosted UI surfaces render in Brass's own visual language. Light/dark is
the one axis you control, defaulting to `'light'`. Override it in two
cases:

- **Dark-only app**: `hostedUiTheme: 'dark'`.
- **App that follows the user's OS preference**: `hostedUiTheme: 'auto'`,
  and only if your own CSS also responds to
  `@media (prefers-color-scheme: dark)`. Otherwise a dark-OS user gets a
  dark embed inside your light app with the close button invisible over
  it.

```ts
await Brass.init('brass_app_live_...', {
  hostedUiTheme: 'auto',
});
```

## CSP

If your app sends a `Content-Security-Policy`, it needs `frame-src
https://app.brass.build` (the README's "Setup" lists the full set). A
bare `default-src 'self'` blocks the iframe, because `frame-src` falls
back to `default-src`, and the failure is silent.

## Mixing with `Brass.session`

The session's file-menu commands invoke these surfaces for you:
`open` opens the picker, `share` and `manage` open the
document-settings dialog, and `history` opens version history. Each
command's `run()` always resolves, and a failure routes to
`Brass.onError` rather than throwing.
