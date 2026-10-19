// The single error type every `@brass-build/client` call rejects with.
//
// One catch type: `.status` carries an HTTP rejection's status, and `.code`
// names a hosted-UI launcher's failure or the code an HTTP refusal carried.
// An HTTP refusal carries the platform's code whatever it is, so a code the
// platform adds after this SDK was built still reaches the app. The codes
// below are the ones an app is expected to act on.
//   - `iframe_unavailable`: this browser / app context can't host the
//     iframe (an app surfaces this as "open in a new tab").
//   - `embed_error`: the embed page cannot proceed (e.g. not signed in).
//   - `not_in_browser`: a non-DOM runtime.
//   - `app_not_installed`: the server rejected the app's action because
//     the target organization has no install of it; `organizationId`
//     names the org so the install-consent flow can be offered.
//   - `app_not_granted`: the reader can open the document, but nobody has
//     handed it to this app. Opening it through `session.open()` does.
//   - `not_imported`: the document's file has not been imported: another
//     app imports it, or this app had not called `registerImporter` when
//     the open stopped waiting for it. Show that the file has not been
//     imported yet; a document that has it as an input lists it as changed
//     once it has.
export type BrassErrorCode =
  | 'not_in_browser'
  | 'iframe_unavailable'
  | 'embed_error'
  | 'app_not_installed'
  | 'schema_conflict'
  | 'app_not_granted'
  | 'not_imported';

export class BrassError extends Error {
  override name = 'BrassError';
  readonly status?: number;
  readonly code?: BrassErrorCode | (string & {});
  readonly organizationId?: string;
  /** Server-authored heading for a prompt this error drives, when the
   *  platform sends one. A client freezes into an app's bundle, so a string
   *  it holds itself can only be corrected by every app republishing. */
  readonly title?: string;

  constructor(
    message: string,
    init?: {
      status?: number;
      code?: BrassErrorCode | (string & {});
      organizationId?: string;
      title?: string;
    },
  ) {
    super(message);
    if (init?.status !== undefined) this.status = init.status;
    if (init?.code !== undefined) this.code = init.code;
    if (init?.organizationId !== undefined) this.organizationId = init.organizationId;
    if (init?.title !== undefined) this.title = init.title;
  }
}
