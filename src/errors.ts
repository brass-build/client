// The single error type every `@brass-build/client` call rejects with.
//
// One catch type, two mutually-exclusive discriminators: branch on
// `.status` for the HTTP surface, `.code` for the hosted-UI launchers (an
// HTTP rejection has no `code`, a launcher rejection no `status`).
//   - `iframe_unavailable`: this browser / app context can't host the
//     iframe (an app surfaces this as "open in a new tab").
//   - `embed_error`: the embed page cannot proceed (e.g. not signed in).
//   - `not_in_browser`: a non-DOM runtime.
//   - `app_not_installed`: the server rejected the app's action because
//     the target organization has no install of it; `organizationId`
//     names the org so the install-consent flow can be offered.
export type BrassErrorCode =
  | 'not_in_browser'
  | 'iframe_unavailable'
  | 'embed_error'
  | 'app_not_installed'
  | 'schema_conflict';

export class BrassError extends Error {
  override name = 'BrassError';
  readonly status?: number;
  readonly code?: BrassErrorCode;
  readonly organizationId?: string;
  /** Server-authored heading for a prompt this error drives, when the
   *  platform sends one. A client freezes into an app's bundle, so a string
   *  it holds itself can only be corrected by every app republishing. */
  readonly title?: string;

  constructor(
    message: string,
    init?: {
      status?: number;
      code?: BrassErrorCode;
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
