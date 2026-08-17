// The `__brass_embed` postMessage envelope, shared by the SDK's three bridge
// endpoints: the hosted-UI launcher (`hosted-ui.ts`) and the version bar
// (`version-bar.ts`), where the SDK is the host, and the export guest
// (`export-guest.ts`), where the SDK is the iframe.
//
// Both sides drop any `message` whose `data[EMBED_ENVELOPE]` is not a version
// they speak, so unrelated postMessage traffic never reaches a handshake.
//
// The SDK's half of every bridge freezes into each app's published bundle,
// so it speaks exactly the version it was built with: it announces this
// version on first contact and accepts only this version inbound. Staying
// compatible across a bump is entirely the central (dashboard-served) side's
// job: that side accepts every version it has ever shipped and replies at the
// one the frozen counterpart announced. Two rules follow, and together they
// are the bridge's compatibility invariant:
//
//   - the central side never drops a version while a published SDK still
//     announces it, so an app pinned to an older client keeps working;
//   - this constant rises only after a dashboard build that accepts the new
//     version is deployed, because the SDK's first message (the launcher's
//     `init`, the guest's `ready`) is what the central side negotiates from.
//     A bump that lands first is dropped by the deployed dashboard, and every
//     hosted dialog in an app carrying it waits out its timeout.
export const EMBED_ENVELOPE = '__brass_embed';
export const EMBED_PROTOCOL_VERSION = 1;
