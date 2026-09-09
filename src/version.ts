// The package version the SDK reports to the backend (the `client`
// query param on /refresh and on the WS connect URL), so the platform
// can measure the version distribution of deployed apps and time
// compatibility windows against it. A unit test pins this to
// package.json's version; the release bump touches both together.
export const SDK_VERSION = '0.4.1';

export const SDK_CLIENT_ID = `sdk/${SDK_VERSION}`;
