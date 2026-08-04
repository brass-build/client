// SDK-managed page title. The session sets the tab / history title to the
// active document's name so history entries and tabs are distinguishable
// (without it every entry the doc-URL sync records reads identically). On by
// default; opt out with `Brass.init(appId, { syncDocToTitle: false })` for
// an app that owns its own `document.title`.
//
// SSR-safe: a no-op when there is no `document`. The write is skipped when
// the title already matches, so calling it on every doc mutation (to follow
// a rename) costs only a string compare.

export function setPageTitle(title: string): void {
  if (typeof document === 'undefined') return;
  if (document.title === title) return;
  document.title = title;
}

// Compose the tab title from the doc-scoped part (already branch-qualified
// by the session, e.g. `Doc` or `Doc (branch)`) and the app name, so a tab
// reads `Doc · App`. A falsy `docTitle` means no document is open, so the
// page's own title stands alone.
//
// `appName` is the page's own `<title>` captured at the first sync, which is
// typically the app name already (it is what the tab and every doc-less
// history entry show), so the qualified title needs no configuration. A
// blank `appName` (a page with an empty `<title>`) yields the bare doc
// title, never a dangling separator.
export function composePageTitle(
  docTitle: string | null,
  appName: string,
): string {
  if (!docTitle) return appName;
  return appName ? `${docTitle} · ${appName}` : docTitle;
}
