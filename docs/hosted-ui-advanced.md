# Hosted UI: advanced

Some surfaces are owned by Brass: you call one method and Brass renders
the UI in a modal iframe over your page, so your app never builds the
screen, fetches the data, or handles the mutation. `Brass.session`
wires the common ones (`history`, `share`, `manage`) behind the file
menu; this page covers the rest and how they behave in browsers that
block the iframe.

## Surfaces

| Method | Returns |
| --- | --- |
| `Brass.selectDocument()` | `Promise<SelectDocumentResult \| null>`: opens the hosted document picker; resolves to the picked document, or `null` if the user dismisses it. |
| `Brass.shareDocument(docId)` | `Promise<void>`: opens the hosted share dialog for the document. |

Version history is a built-in file-menu command (`history` in
`session.commands` and the SDK toolbar's file menu), not a launcher
method; an app on `mountToolbar` or `mountFileMenu` gets it with no
code.

## Redirects in browsers that block the iframe

Where the browser blocks the Hosted UI iframe (Safari, Firefox, Chrome
with third-party cookies off), these surfaces open as a full-page
redirect to Brass and return to your app when the user is done. The
picker returns with the chosen document opened into `Brass.session`.

So render the active document from the session (or `mountToolbar`): on
the redirect path the page reloads, so the code after `await
Brass.selectDocument()` never runs, and the pick arrives through the
session instead. The resolved value is the modal path's inline
convenience, correct whenever you receive it.

## `BrassError` `.code` values

The hosted-UI launchers reject with `BrassError` carrying a `.code`
(rather than the `.status` the HTTP namespaces set):

- `'embed_error'`: the hosted page loaded but couldn't proceed (e.g.
  the user isn't signed in to Brass in this context).
- `'not_in_browser'`: called outside a browser environment.

## Theming

Hosted UI surfaces render in Brass's own visual language; light/dark is
the one axis you control, defaulting to `'light'`. Override in two
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
back to `default-src`, and the failure is silent. Apps that send no CSP,
or no `frame-src` / `default-src`, need no change.

## Mixing with `Brass.session`

The session's file-menu commands invoke these surfaces for you:
`open` opens the picker, `share` and `manage` open the
document-settings dialog, and `history` opens version history. Each
command's `run()` always resolves; a failure routes to `Brass.onError`
rather than throwing.
