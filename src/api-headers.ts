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

// Attaches the SDK's version as `x-brass-client` (`sdk/<version>`), the same
// value reported on /refresh and the WS connect URL, so the server sees the
// deployed SDK version at the data-API surface too. The minimum-version gate
// reads it at document open to serve a too-old client an upgrade message
// (rendered verbatim through `session.error`). Same boundary as the
// app-assertion header: data API only, never a presigned URL. Unconditional, so the
// version distribution covers read-only apps that never refresh.
export function applyClientVersionHeader(headers: Record<string, string>): void {
  headers['x-brass-client'] = SDK_CLIENT_ID;
}
