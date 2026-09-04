// Which organization an act that has no document spends.
//
// An app opened from a dashboard is launched with one, and an app holding an
// open document inherits that document's. Everything else is resolved by the
// server from the caller's own context at the first act that needs it, so the
// app is never handed a list and never asks at boot.
//
// The per-app sessionStorage slot below carries the answer forward within a
// tab: keys are namespaced per app id so integrations on one origin don't
// collide, and the slot is cleared on sign-out (session storage also drops on
// tab close).

import { applyAppAssertionHeader, applyClientVersionHeader } from './api-headers.js';
import { BrassError } from './errors.js';

const KEY_PREFIX = '__brass_acting_org_';

// Single per-page-load warn: a resolve runs on every act that needs an
// organization, so without the latch a server-rendered host would flood its
// logs.
let warnedUnavailable = false;

function getStorage(): Storage | null {
  if (typeof sessionStorage === 'undefined') return null;
  try {
    return sessionStorage;
  } catch {
    return null;
  }
}

function warnOnceUnavailable(): void {
  if (warnedUnavailable) return;
  warnedUnavailable = true;
  console.warn(
    'Brass: sessionStorage is unavailable, so the organization this app acts in is resolved again on every page load.',
  );
}

function orgKey(appId: string): string {
  return `${KEY_PREFIX}${appId}`;
}

export function storeActingOrganization(appId: string, organizationId: string): void {
  const storage = getStorage();
  if (!storage) {
    warnOnceUnavailable();
    return;
  }
  try {
    storage.setItem(orgKey(appId), organizationId);
  } catch {
    // Quota / disabled storage; drop silently. The stored value is a
    // preference the server re-derives without it, so losing it costs a
    // resolve rather than the act that needed one.
  }
}

export function readActingOrganization(appId: string): string | null {
  const storage = getStorage();
  let raw: string | null;
  if (!storage) return null;
  try {
    raw = storage.getItem(orgKey(appId));
  } catch {
    // A storage that holds a handle but refuses reads (a partitioned or
    // locked-down context). See `storeActingOrganization`.
    return null;
  }
  const trimmed = raw?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

export function clearActingOrganization(appId: string): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.removeItem(orgKey(appId));
  } catch {
    // See `storeActingOrganization`.
  }
}

// What the server answers when asked which organization this caller acts in:
// one organization, or the reason it cannot name one. Never a list.
export type ResolveOutcome =
  | {
      kind: 'resolved';
      organizationId: string;
      organizationName: string;
      /**
       * Whether this app is installed on the organization. A deliberate
       * switch reads it so the install is raised before the switch takes
       * effect, rather than leaving the reader acting somewhere the next call
       * is refused.
       */
      installed: boolean;
    }
  | { kind: 'needs-choice' }
  | { kind: 'no-organization' };

export interface ResolveDeps {
  /** The open document's organization, where one is open. */
  activeDocumentOrganizationId: () => Promise<string | null>;
  /** An organization already resolved on this page load. */
  cachedResolution: () => string | null;
  /**
   * The organization the launch named, where this page load carried one. A
   * person clicking Open from an organization's dashboard has just said where
   * they are working, so it outranks a carried choice and is never read as
   * stale: an app the organization has not installed is what the install
   * consent behind the refusal is for.
   */
  launchPreference: () => string | null;
  /** The choice this tab carries for this app, from an earlier act. */
  storedPreference: () => string | null;
  fetchResolved: (prefer: string | null) => Promise<ResolveOutcome>;
  /** The hosted dialog that asks the person; null when they dismissed it. */
  pickOrganization: () => Promise<string | null>;
  /**
   * Drop the stored choice, for one the app can no longer act in. The server
   * validates a preference against MEMBERSHIP, so a choice naming an
   * organization the app has since been uninstalled from stays resolvable
   * forever while serving nothing.
   */
  forgetPreference: () => void;
  remember: (
    organizationId: string,
    /** Empty where the resolution carried an id and no name. */
    organizationName: string,
    /**
     * Whether to carry the choice past this page load. An organization this
     * app is not installed on has not become one the app can act in yet: the
     * act that resolved it is about to be refused, and the reader may decline
     * the install that follows. Recording it anyway pins every later visit to
     * an organization nothing they press can work in, with the chooser out of
     * reach. It is persisted when the install lands instead.
     */
    persist: boolean,
  ) => void;
}

/**
 * Which organization the next act uses.
 *
 * `ask: false` runs the same ladder and stops where it would raise the hosted
 * chooser, answering null instead. That is what an app reading its own state
 * before it acts needs: the question the chooser asks is one only the person
 * can answer, and asking it unbidden takes the page over for something the
 * reader never pressed.
 */
export async function resolveActingOrganization(
  deps: ResolveDeps,
  options: { ask?: boolean } = {},
): Promise<string | null> {
  const fromDocument = await deps.activeDocumentOrganizationId();
  if (fromDocument) {
    // Recorded, not merely returned. This is where the app is working, so it
    // is what the next act spends once the document closes; without it a
    // reader who opens a document, closes it and creates another is asked
    // where to put the second one, having just worked in the answer. It carries no name (the
    // document named an id) and does not reach the tab's slot: a document
    // can live in an organization the reader reaches through a shared
    // project and is not a member of, which is a place to act from while it
    // is open rather than a choice to carry.
    deps.remember(fromDocument, '', false);
    return fromDocument;
  }
  const cached = deps.cachedResolution();
  if (cached) return cached;

  // The stored choice is a preference rather than an answer: the server
  // validates it against membership and ignores one that no longer holds, so
  // a stale value self-heals into whatever the caller's context resolves to.
  const launch = deps.launchPreference();
  const stored = launch === null ? deps.storedPreference() : null;
  const first = await deps.fetchResolved(launch ?? stored);
  if (first.kind === 'resolved') {
    // Membership is not the whole of what makes a choice usable. An
    // organization the app has been uninstalled from still resolves, so a
    // stored choice naming one would raise the install for a place somebody
    // deliberately removed this app from, on every load, for as long as the
    // tab lives. Read as stale instead: drop it and ask again with no
    // preference, which reaches whatever this caller's context resolves to
    // and otherwise the chooser, where the reader says where to work now.
    //
    // Only for a choice this tab was CARRYING. A launch, a resolution the
    // reader just made, or their single membership is the answer either way,
    // and the install is what it needs.
    if (!first.installed && stored !== null && first.organizationId === stored) {
      deps.forgetPreference();
      const healed = await deps.fetchResolved(null);
      if (healed.kind === 'resolved') return keep(deps, healed);
    } else {
      return keep(deps, first);
    }
  }

  // Context could not answer. Only the person can, so a caller that asked not
  // to raise a surface is told that rather than asked.
  if (options.ask === false) return null;

  // The surface offers their own memberships and creates one where they have
  // none, so the answer it gives is always one the server can resolve: asking
  // twice would be asking the same question again rather than making progress.
  const picked = await deps.pickOrganization();
  if (!picked) {
    throw new BrassError(
      first.kind === 'no-organization'
        ? 'No organization yet. Create one to continue.'
        : 'No organization chosen.',
      { status: 400 },
    );
  }
  const second = await deps.fetchResolved(picked);
  if (second.kind === 'resolved') return keep(deps, second);
  throw new BrassError('Brass could not use the organization you chose.', {
    status: 400,
  });
}

function keep(
  deps: ResolveDeps,
  outcome: Extract<ResolveOutcome, { kind: 'resolved' }>,
): string {
  deps.remember(outcome.organizationId, outcome.organizationName, outcome.installed);
  return outcome.organizationId;
}

/**
 * What the chrome names: the organization the NEXT act would spend.
 *
 * An open document takes it over, because the document's organization is what
 * every act made while it is open spends. That holds even when the name is
 * unknown, which is a document in an organization this reader reaches through
 * a directly shared project: the menu says nothing rather than naming the memo
 * over it. Closing the document hands it back, so the two never disagree with
 * what the app is about to do.
 *
 * Named whether or not the caller belongs to anywhere else. The menu offers a
 * switch, and the surface behind it is also how a first or a second
 * organization gets created, so what a caller with one has is a choice they
 * have not made yet rather than no choice; naming the organization is what
 * makes that switch legible instead of an offer to change something the menu
 * never states.
 *
 * Null where neither is known, which is an ordinary state rather than a gap
 * to fill: an app reached by its own URL, holding no document and nothing
 * stored, has no organization until an act needs one, and resolving one to
 * decorate a menu is exactly the boot-time question this design refuses.
 */
export function visibleOrganization(
  openDocument: { organization: Named | null } | null,
  memo: Named | null,
): { id: string; name: string } | null {
  // An open document takes the menu over ENTIRELY, naming its organization
  // or nothing. Falling back to the memo here would be the exact fault this
  // exists to prevent: the document's organization is what its acts spend,
  // so a menu naming the memo over an open document names an organization
  // the app is not using.
  if (openDocument) return named(openDocument.organization);
  return named(memo);
}

interface Named {
  id: string;
  name: string;
}

function named(organization: Named | null): { id: string; name: string } | null {
  // An id with no name is a resolution taken from an open document, which
  // names no organization. There is nothing to draw until the chrome asks the
  // server for one.
  if (!organization || organization.name === '') return null;
  return { id: organization.id, name: organization.name };
}

export interface ActingOrganizationFetchDeps {
  apiBaseUrl: string;
  getAccessToken: () => Promise<string | null>;
  getAppAssertion: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

// The refusals that are a question for the person rather than a fault: the
// caller belongs to several organizations and none of the context named one,
// or belongs to none at all.
const OUTCOME_CODES: ReadonlyMap<string, 'needs-choice' | 'no-organization'> = new Map([
  ['destination_required', 'needs-choice'],
  ['no_organization', 'no-organization'],
]);

export async function fetchActingOrganization(
  deps: ActingOrganizationFetchDeps,
  prefer: string | null,
): Promise<ResolveOutcome> {
  const token = await deps.getAccessToken();
  if (!token) throw new BrassError('Not signed in', { status: 401 });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  applyClientVersionHeader(headers);
  await applyAppAssertionHeader(headers, deps.getAppAssertion);
  const base = deps.apiBaseUrl.replace(/\/$/, '');
  const query = prefer ? `?prefer=${encodeURIComponent(prefer)}` : '';
  const doFetch = deps.fetchImpl ?? fetch;
  const response = await doFetch(`${base}/me/acting-organization${query}`, {
    method: 'GET',
    headers,
  });
  type Body = {
    organization_id?: unknown;
    organization_name?: unknown;
    installed?: unknown;
    error?: unknown;
    code?: unknown;
  };
  let body: Body = {};
  try {
    body = (await response.json()) as Body;
  } catch {
    // Leaves the generic message below, which the status already qualifies.
  }
  if (response.ok && typeof body.organization_id === 'string') {
    return {
      kind: 'resolved',
      organizationId: body.organization_id,
      organizationName:
        typeof body.organization_name === 'string' ? body.organization_name : '',
      // Absent reads as installed, so an older api that does not send it
      // leaves the act to raise the refusal as it always did rather than
      // asking for an install nothing established was missing.
      installed: body.installed !== false,
    };
  }
  const kind =
    typeof body.code === 'string' ? OUTCOME_CODES.get(body.code) : undefined;
  if (response.status === 409 && kind) return { kind };
  throw new BrassError(
    typeof body.error === 'string' ? body.error : 'Could not resolve an organization',
    { status: response.status },
  );
}

/**
 * A deliberate switch, as the account menu drives it. Separate from
 * `resolveActingOrganization` because the two differ in what follows the
 * choice: a resolve is followed by the act that asked for it, which raises
 * its own refusal, while a switch is followed by nothing at all. So the
 * switch has to establish for itself that the app can act where the reader
 * sent it, and has to tell the app that everything it read is now about a
 * different organization.
 */
export interface SwitchDeps {
  /** The organization being acted in now, so the surface can mark it. */
  current: () => string | null;
  pickOrganization: (current: string | undefined) => Promise<string | null>;
  fetchResolved: (prefer: string) => Promise<ResolveOutcome>;
  /** The hosted install dialog, pinned; null when the reader declined. */
  offerInstall: (organizationId: string) => Promise<boolean>;
  remember: (organizationId: string, organizationName: string) => void;
  /** Re-reads the app under the new organization. */
  reload: () => void;
}

export async function switchActingOrganization(deps: SwitchDeps): Promise<boolean> {
  const current = deps.current() ?? undefined;
  const picked = await deps.pickOrganization(current);
  if (!picked) return false;
  // Re-picking the organization the app is already acting in is a valid
  // answer to the question the surface asks, and it moves nothing. The
  // ordinary way to reach it is a caller with one organization opening the
  // chooser to see what is there, so it must not cost them their open
  // document and a page reload to say where they already are.
  if (picked === current) return false;
  // The pick goes back to the server, which names the organization as the
  // platform holds it and refuses one the caller cannot act in.
  const named = await deps.fetchResolved(picked);
  if (named.kind !== 'resolved') return false;
  // An organization this app is not installed on cannot serve it, so the
  // install is asked for here rather than left to the next act. Without this
  // the switch appears to succeed and the refusal arrives later, or on a
  // reload, against work the reader has already started.
  if (!named.installed && !(await deps.offerInstall(named.organizationId))) {
    // Declining abandons the switch. Recording an organization the app cannot
    // act in leaves the reader on one organization's screen with nothing they
    // press able to work.
    return false;
  }
  deps.remember(named.organizationId, named.organizationName);
  // Everything the app read under the previous organization is about a
  // different one now, and the app has no way to know which of its own state
  // that covers. The reader asked for this, so re-reading the app is the
  // expected consequence of their own act rather than a surprise, and the
  // choice is already recorded so it survives.
  deps.reload();
  return true;
}
