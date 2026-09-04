import { SDK_CLIENT_ID } from './version.js';

// Attaches the acting-app assertion as `X-Brass-App-Assertion` when one
// is available; a no-op when the caller has none.
//
// MUST only be applied to requests to the Brass data API. Never attach
// it to other origins, in particular the presigned snapshot/upload
// URLs the document path fetches, which must carry no Brass headers (a
// stray header would also break the presigned signature's allowed-header
// set).
export async function applyAppAssertionHeader(
  headers: Record<string, string>,
  getAppAssertion?: () => Promise<string | null>,
): Promise<void> {
  const assertion = await getAppAssertion?.();
  if (assertion) headers['x-brass-app-assertion'] = assertion;
}

// Names the SDK and its version. Brass answers a build too old to serve with
// an upgrade message, which reaches the app as `session.error` and is
// rendered verbatim.
//
// Same boundary as the app-assertion header: Brass's own API calls carry it,
// a presigned URL never does. Attached unconditionally, so an app that only
// ever reads carries it too.
export function applyClientVersionHeader(headers: Record<string, string>): void {
  headers['x-brass-client'] = SDK_CLIENT_ID;
}
