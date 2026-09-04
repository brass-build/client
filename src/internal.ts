// The entry point Brass's own surfaces import
// (`@brass-build/client/internal`).
//
// The dashboard, the operator console, and this package's tests consume
// the SDK as their client library and reach for primitives that sit
// below the `Brass` namespace: the client class that namespace wraps,
// the WS transport, the auth-flow helpers, and the init-key vocabulary
// the dashboard quickstart renders. They live on their own subpath so
// the default import (`@brass-build/client`) offers apps the `Brass`
// surface the README documents, and an assistant scaffolding from that
// README stays on it.

export { BrassClient } from './client.js';
export { BrassWsClient } from './ws-client.js';
export {
  buildSignInUrl,
  refreshTokens,
  type RefreshCredential,
  type RefreshOutcome,
  type RefreshResult,
  type TokenSet,
} from './auth-flow.js';
export { decodeIdToken } from './jwt.js';
export {
  readDocumentContents,
  type DocumentContents,
} from './document-contents.js';
export {
  fetchWithRetry,
  RETRY_READ,
  type RetryOptions,
  type RetryPolicy,
} from './fetch-retry.js';
export { BRASS_INIT_ARG_KEYS, type BrassInitArgKey } from './init-keys.js';
