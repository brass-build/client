// The loop that places a document through the hosted surfaces: run an
// attempt, open the surface each `needs-*` outcome names, and retry with
// what it returned. Shared by the session's create and the client's claim of
// a document created without an account, so the two cannot drift on which
// surface answers which refusal.

import type {
  AcquireOrganizationResult,
  CreateDestinationResult,
} from './hosted-ui.js';

export interface PlacementSurfaces {
  acquireOrganization(): Promise<AcquireOrganizationResult | null>;
  selectCreateDestination(options?: {
    name?: string;
  }): Promise<CreateDestinationResult | null>;
}

// Run `attempt` until the server places the document. `needs-organization`
// opens the acquire surface and retries with `{ organization_id }`;
// `needs-destination` opens the destination dialog (pre-filled with `name`)
// and retries with its opaque result, relayed verbatim. Resolves null when
// the person dismisses a surface. `onDestination` hears the dialog's result,
// which also carries the name the person settled on.
export async function placeThroughHostedSurfaces<R extends { kind: string }>(
  surfaces: PlacementSurfaces,
  attempt: (destination: unknown) => Promise<R>,
  name: string | undefined,
  onDestination?: (chosen: CreateDestinationResult) => void,
): Promise<Exclude<R, { kind: 'needs-organization' | 'needs-destination' }> | null> {
  let destination: unknown = undefined;
  for (;;) {
    const result = await attempt(destination);
    if (result.kind === 'needs-organization') {
      const acquired = await surfaces.acquireOrganization();
      if (!acquired) return null;
      destination = { organization_id: acquired.organization_id };
      continue;
    }
    if (result.kind === 'needs-destination') {
      const chosen = await surfaces.selectCreateDestination(
        name !== undefined ? { name } : undefined,
      );
      if (chosen === null) return null;
      onDestination?.(chosen);
      destination = chosen;
      continue;
    }
    return result as Exclude<
      R,
      { kind: 'needs-organization' | 'needs-destination' }
    >;
  }
}
