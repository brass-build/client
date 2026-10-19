// Single source of truth for the set of keys an integration needs to
// plug into `Brass.init`. When you add a new field to `Brass.init`,
// add the key here first.

// Keys used in the prompt block the dashboard renders. The `app_id`
// line carries the app-specific id; the URL lines carry the env's
// auth / data / WS / dashboard origins.
//
// Every origin `Brass.init` takes belongs here: each falls back to its own
// default independently, so a prompt naming a subset leaves the rest on
// theirs.
export const BRASS_INIT_ARG_KEYS = [
  'app_id',
  'auth_base_url',
  'api_base_url',
  'ws_base_url',
  'dashboard_base_url',
] as const;

export type BrassInitArgKey = (typeof BRASS_INIT_ARG_KEYS)[number];
