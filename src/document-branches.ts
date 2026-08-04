// Document branches (alternate states of the same design): the reactive
// list, the injected HTTP provider that lists / creates them, and the
// optimistic-append on create.

import type {
  BranchSummary,
  CreateBranchRequest,
} from './documents-namespace.js';

// Injected HTTP capability the controller's branch methods call through.
export interface BranchProvider {
  list(docId: string): Promise<{
    default_branch_id: string;
    branches: BranchSummary[];
  }>;
  create(docId: string, input: CreateBranchRequest): Promise<BranchSummary>;
}

export interface BranchControllerHost {
  // Server identity; `null` on the offline / test path.
  docId(): string | null;
  // The branch the Document is open on (a new branch forks from here).
  // `null` on the offline / test path.
  branchId(): string | null;
  // True when the doc is live (not closed / suspended).
  isActive(): boolean;
  // Fire the Document's `branches` subscribe event so a branch picker
  // re-reads inside the existing subscribe handler.
  onBranchesChanged(branches: readonly BranchSummary[]): void;
}

export class BranchController {
  // Reactive branches list. Set by the factory's initial fetch, then by
  // `refresh` and `create`. Empty until that fetch resolves.
  private _branches: readonly BranchSummary[] = [];
  private _defaultBranchId: string | null = null;
  // `null` on the offline / test path with no transport.
  private _provider: BranchProvider | null = null;

  constructor(private readonly host: BranchControllerHost) {}

  get branches(): readonly BranchSummary[] {
    return this._branches;
  }

  get defaultBranchId(): string | null {
    return this._defaultBranchId;
  }

  // Whether a provider is attached. The file-menu's branches submenu
  // reads this to decide whether to offer "New branch...".
  get hasProvider(): boolean {
    return this._provider !== null;
  }

  // Set the branches list and fire the `branches` subscribe event.
  set(
    branches: readonly BranchSummary[],
    defaultBranchId: string | null,
  ): void {
    this._branches = branches;
    this._defaultBranchId = defaultBranchId;
    this.host.onBranchesChanged(branches);
  }

  setProvider(provider: BranchProvider | null): void {
    this._provider = provider;
  }

  // Re-fetch the branches list from the server. Useful after an
  // out-of-band change another peer made; not normally needed because
  // `create` updates the list automatically.
  async refresh(): Promise<void> {
    if (!this.host.isActive()) return;
    const docId = this.host.docId();
    if (docId === null || this._provider === null) return;
    const { default_branch_id, branches } = await this._provider.list(docId);
    if (!this.host.isActive()) return;
    this.set(branches, default_branch_id);
  }

  // Create a new branch under this document, forked from the branch the
  // Document is open on. Updates `branches` on success (optimistic
  // append; the next refresh reconciles any drift).
  async create(input: {
    name?: string;
    from_version?: number;
  }): Promise<BranchSummary> {
    if (!this.host.isActive()) {
      throw new Error('Document is closed');
    }
    const docId = this.host.docId();
    const branchId = this.host.branchId();
    if (docId === null) {
      throw new Error('createBranch: Document has no server identity');
    }
    if (branchId === null) {
      throw new Error('createBranch: Document has no branch');
    }
    if (this._provider === null) {
      throw new Error(
        'createBranch: no provider attached. Opened via the SDK factory?',
      );
    }
    const request: CreateBranchRequest = {
      from_branch_id: branchId,
    };
    if (input.name !== undefined) request.name = input.name;
    if (input.from_version !== undefined) {
      request.from_version = input.from_version;
    }
    const branch = await this._provider.create(docId, request);
    // Re-check liveness after the await, exactly as `refresh` does: a
    // `close()` in flight nulls the host's Loro subscription and frees its
    // doc, so firing the `branches` change (which re-attaches that
    // subscription) would run against a freed document. The create already
    // landed server-side, so still return the branch; just skip the
    // reactive `set` a torn-down document can't consume.
    if (!this.host.isActive()) return branch;
    const next: BranchSummary[] = [...this._branches, branch];
    this.set(next, this._defaultBranchId);
    return branch;
  }
}
