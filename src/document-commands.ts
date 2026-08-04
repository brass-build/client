// Document file-menu commands: the per-doc list of built-in actions a
// multi-doc app reads as data and places into its own chrome (Version
// history / Branches / Details / Share / Delete suggested for the menu,
// Undo / Redo suggested for the toolbar), plus the branches submenu.
//
// The SDK owns the action set, each command's live `enabled` / `running`
// state, and its `run()`; the app owns placement and styling. Each
// command carries a `surface` hint ('menu' | 'toolbar') the app is free
// to honor or ignore. The SDK does not render the menu itself: an app
// surfaces its own actions with its own buttons and calls SDK methods
// directly.

import type {
  DocumentHistoryResult,
  DocumentSettingsFocus,
  DocumentSettingsResult,
  DriveResolveResult,
} from './hosted-ui.js';
import type { BranchSummary } from './documents-namespace.js';

// Hosted-UI capabilities the built-in commands need (history modal,
// manage / share actions, branch picker). Injected by the factory; same
// DI shape as the Document's other providers.
export interface HostedUiProvider {
  documentHistory(
    docId: string,
    options?: { branch?: string },
  ): Promise<DocumentHistoryResult | null>;
  // Resolves with the copy's id when the user duplicated the document
  // there and asked to open it; `null` otherwise.
  documentSettings(
    docId: string,
    options?: { focus?: DocumentSettingsFocus },
  ): Promise<DocumentSettingsResult | null>;
  // Optional callback invoked after a settings-driven rename so the
  // Document can refresh its cached name. The factory wires this to
  // a `documents.get` call; passing the new name keeps the round
  // trip on the SDK side rather than forcing the app to re-fetch.
  refreshName?: (docId: string) => Promise<string | null>;
  // Called by the `history` built-in for a fork outcome or cross-branch
  // version: the doc checks out only its own branch in place, so
  // switching branches needs a higher-level coordinator. The session
  // wires this to `session.open` (single-doc apps get instance-swap
  // routing for free); multi-doc apps wire their own.
  openSiblingDoc?: (
    docId: string,
    options: { branch?: string; version?: number },
  ) => Promise<void>;
  selectBranch?: (
    docId: string,
    options?: { branch?: string },
  ) => Promise<{ branch_id: string } | null>;
  // Open the hosted drive-divergence resolution surface
  // (`Document.resolveDrive()` routes through this). Resolves with the
  // outcome (a fresh mirror doc id, or `null` newDocId for an in-place
  // publish-over), or `null` when dismissed.
  driveResolve?: (docId: string) => Promise<DriveResolveResult | null>;
  // Open the hosted acquire-organization surface for a caller with zero
  // organizations; resolves with the organization they created or
  // joined, or `null` if dismissed. `createDocument`'s implicit-org
  // resolution falls back to this instead of throwing.
  acquireOrganization?: () => Promise<{ organization_id: string } | null>;
  // Whether someone can produce a file from this document, the same
  // question the hosted share dialog gates its download row on. The
  // `share` built-in's label names the download only when this resolves
  // true, so the menu entry offers exactly what the dialog holds. The
  // factory wires it to a `documents.get` read. `null` means the read
  // could not tell (it was refused or it failed), which the label treats
  // as a no and retries; only `true` / `false` settle it.
  documentDownloadable?: (docId: string) => Promise<boolean | null>;
}

// One entry in the file menu. The Document owns these (each doc
// carries its own command list with its own `running` state); the
// session concatenates its orphan commands ('new' / 'open') with the
// active doc's commands so single-doc apps see one unified list.
export interface Command {
  // Stable identifier: 'new' | 'open' | 'history' | 'branches' |
  // 'manage' | 'share' | 'undo' | 'redo'.
  readonly id: string;
  // Display label, sentence case, ready to render verbatim. A command may
  // relabel as its state settles (`share` names the download once it knows
  // the document has one), so read it on every notification the way
  // `enabled` is read.
  readonly label: string;
  // 'session' (New / Open, which put a different document on screen),
  // 'document' (this document: version history, branches, share, manage),
  // or 'edit' (Undo / Redo). Render a separator where the group changes
  // when laying commands out in one surface.
  readonly group: CommandGroup;
  // Suggested chrome for this command: 'menu' (a hamburger / file menu)
  // or 'toolbar' (a prominent button). A hint, not a requirement; the
  // app filters `commands` by `surface` to place each one, or ignores
  // it and lays them out however it likes.
  readonly surface: CommandSurface;
  // Whether invoking the command would do anything right now. The SDK
  // recomputes this as state changes; re-read on every notification.
  readonly enabled: boolean;
  // True while `run()` is in flight. Drives the pending affordance
  // (disable + relabel) without the app tracking it.
  readonly running: boolean;
  // Optional submenu items. When present, render the command as a
  // submenu parent (label + disclosure chevron) and the children as
  // nested items. The parent's own `run()` is a no-op; each child
  // has its own `run()`. Used by the built-in `branches` command.
  readonly children?: readonly Command[];
  // True when this command represents the currently active choice in
  // a submenu (e.g. the active branch). Render a checkmark or bold.
  readonly selected?: boolean;
  // Invoke the command. Always resolves; a failure is routed to
  // `Brass.onError`, never thrown, so a render-loop `onclick` handler
  // does not need a `.catch`.
  run(): Promise<void>;
}

export type CommandGroup = 'session' | 'document' | 'edit';

// Suggested chrome for a command. The app is free to honor or ignore it.
export type CommandSurface = 'menu' | 'toolbar';

// Built-in doc-scoped command labels. The session adds 'new' / 'open'
// (which don't need an active doc) at its own level.
const DOC_COMMAND_LABELS = {
  history: 'Version history...',
  branches: 'Branches...',
  // Rename / move / delete are one surface ("the document's place in the
  // filesystem"), so they are one menu entry, not separate Details + Delete.
  manage: 'Manage...',
  share: 'Share...',
  undo: 'Undo',
  redo: 'Redo',
} as const;

// The `share` label on a document someone can take a file away from.
// Taking a copy out is one row of the share dialog, beside the access
// roster, the way a phone's share sheet holds "save a file" next to "send
// to a person", so it earns a name in the entry that opens that dialog
// rather than a menu entry of its own. A document with no file to hand
// over keeps the plain label, so the entry never names a download the
// dialog does not offer.
const SHARE_WITH_DOWNLOAD_LABEL = 'Share / Download...';

// How many times a document's downloadable read may be attempted before the
// label stays as it is for the rest of the document's life, and how long a
// read that could not tell holds off the next attempt. The delay is what
// makes the retry cover the case it exists for: a session emits several
// times in its first second, so retrying per render would spend every
// attempt before the install that refused the read has landed.
const DOWNLOADABLE_MAX_ATTEMPTS = 3;
const DOWNLOADABLE_RETRY_DELAY_MS = 5000;

// Suggested chrome per built-in: the per-doc actions live in the file
// menu; Undo / Redo are toolbar buttons (the shape canvas / text apps
// reach for). 'branches' is built separately but shares the 'menu' hint.
const DOC_COMMAND_SURFACES: Record<
  keyof typeof DOC_COMMAND_LABELS,
  CommandSurface
> = {
  history: 'menu',
  branches: 'menu',
  manage: 'menu',
  share: 'menu',
  undo: 'toolbar',
  redo: 'toolbar',
};

function commandToError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

// Assemble a live `Command`. The returned object exposes `label` /
// `enabled` / `running` as getters over the injected state, so one stable
// instance reflects state changes and reconcilers match it by reference;
// never spread it (`{ ...cmd }` snapshots the getters into frozen values).
export function makeLiveCommand(
  spec: Pick<Command, 'id' | 'group' | 'surface' | 'selected'> & {
    // A function for a label that tracks state (`share` names the download
    // once the document is known to have one).
    label: string | (() => string);
    // Defaults to "enabled unless running".
    isEnabled?: () => boolean;
    impl: () => Promise<void> | void;
  },
  wiring: {
    // Shared per-id running map; defaults to a flag local to this command.
    running?: Map<string, boolean>;
    onError: (err: unknown) => void;
    // Fires after each running flip so subscribers re-read.
    notify?: () => void;
  },
): Command {
  const { running: map, onError, notify } = wiring;
  const label = spec.label;
  const readLabel = typeof label === 'function' ? label : (): string => label;
  let localFlag = false;
  const readRunning = map
    ? (): boolean => map.get(spec.id) === true
    : (): boolean => localFlag;
  const setRunning = (value: boolean): void => {
    if (map) map.set(spec.id, value);
    else localFlag = value;
    notify?.();
  };
  const isEnabled = spec.isEnabled ?? ((): boolean => !readRunning());
  return {
    id: spec.id,
    group: spec.group,
    surface: spec.surface,
    ...(spec.selected !== undefined ? { selected: spec.selected } : {}),
    get label(): string {
      return readLabel();
    },
    get enabled(): boolean {
      return isEnabled();
    },
    get running(): boolean {
      return readRunning();
    },
    async run(): Promise<void> {
      if (readRunning() || !isEnabled()) return;
      setRunning(true);
      try {
        await spec.impl();
      } catch (err) {
        onError(err);
      } finally {
        setRunning(false);
      }
    },
  };
}

// The contract the built-in command implementations need back from the
// owning Document. Wide because the file menu is, by design, the
// surface that reaches across every other doc capability (history /
// checkout, branches, undo, rename).
export interface CommandMenuHost {
  docId(): string | null;
  branchId(): string | null;
  // True when the doc is showing a historical version (built-in
  // `enabled` rules disable edit affordances then).
  readOnly(): boolean;
  // True when the doc is live (not closed / suspended).
  isLive(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  undo(): void;
  redo(): void;
  // Same-branch version preview folds onto the doc in place.
  checkoutVersion(version: number): Promise<void>;
  // Show the version-browsing surface over the live document, without
  // checking anything out. The hosted history dialog returns this when the
  // reader wants to browse in the application rather than pick in a modal.
  browseVersions(): void;
  // Branches submenu reads the list + provider presence and creates.
  branches(): readonly BranchSummary[];
  hasBranchProvider(): boolean;
  createBranch(input: { name?: string; from_version?: number }): Promise<BranchSummary>;
  // Re-pull the branch list from the server. The `branches` built-in
  // calls this after the hosted dialog closes without a switch, so a
  // rename made in the dialog reaches the cached list the branch chip
  // and page title read the active branch name from.
  refreshBranches(): Promise<void>;
  // The `details` built-in refreshes the cached doc name after a rename.
  setName(name: string): void;
  // Fire the Document's `commands` subscribe event so the menu
  // re-renders (a label / running / registration change).
  onCommandsChanged(): void;
}

export class CommandMenu {
  // Hosted-UI provider for built-in commands. `null` until the factory
  // wires it; the built-ins' `enabled` rule reads `_hostedUi !== null`
  // so they disable in tests / offline flows.
  private _hostedUi: HostedUiProvider | null = null;
  // Per-built-in `running` flag, set during a command's `run()` and
  // cleared after. Drives the pending-affordance UI.
  private readonly _builtinRunning = new Map<string, boolean>();
  // Lazily-built built-in command instances. The `Command` shape
  // exposes getters that read live state (`enabled` / `running`), so
  // the same object reflects state changes without recreating.
  private _builtinCommands: readonly Command[] | null = null;
  // Optional error reporter for built-in command failures. Wired by
  // the factory to `Brass.onError`'s emit path; `null` falls back
  // to `console.error`.
  private _onError: ((err: Error) => void) | null = null;
  // Whether this document has a file someone can take away, which is what
  // the `share` label names. `false` until the read lands, so the entry
  // only ever promises what is confirmed.
  private _downloadable = false;
  private _downloadableSettled = false;
  private _downloadableInFlight = false;
  private _downloadableAttempts = 0;
  private _downloadableRetryAt = 0;

  constructor(private readonly host: CommandMenuHost) {}

  setHostedUiProvider(provider: HostedUiProvider | null): void {
    this._hostedUi = provider;
  }

  // Optional error sink for the doc's built-in commands. Wired by
  // the factory to `Brass.onError`'s emit path so async failures
  // surface through one stream. `null` falls back to `console.error`.
  setErrorReporter(reporter: ((err: Error) => void) | null): void {
    this._onError = reporter;
  }

  // The per-doc file menu, as data. Each Document carries its own list
  // with its own `running` state; multi-doc apps render one menu per
  // pane. The app filters by `surface` to place each command.
  get commands(): readonly Command[] {
    this._resolveDownloadable();
    return this._builtins();
  }

  // Ask, on a read of the list, whether this document has a file to hand
  // over. Reading the list is what every menu renderer does as it mounts,
  // so the answer lands long before a reader opens the menu, while an app
  // that renders no menu never spends the request.
  //
  // A read that could not tell (`null`: refused, or failed) leaves the
  // plain `Share...` label and lets a later render try again, because the
  // moment it is most likely to be refused is the first create in an
  // organization, where the install lands seconds afterwards and the
  // document becomes readable. The delay and the attempt cap are what keep
  // that to a few spaced requests rather than one per render.
  private _resolveDownloadable(): void {
    if (this._downloadableSettled || this._downloadableInFlight) return;
    if (this._downloadableAttempts >= DOWNLOADABLE_MAX_ATTEMPTS) return;
    if (Date.now() < this._downloadableRetryAt) return;
    const resolve = this._hostedUi?.documentDownloadable;
    const docId = this.host.docId();
    if (!resolve || docId === null) return;
    this._downloadableAttempts++;
    this._downloadableInFlight = true;
    void resolve(docId).then(
      (downloadable) => {
        this._downloadableInFlight = false;
        if (downloadable === null) {
          this._downloadableRetryAt = Date.now() + DOWNLOADABLE_RETRY_DELAY_MS;
          return;
        }
        this._downloadableSettled = true;
        if (downloadable === this._downloadable) return;
        this._downloadable = downloadable;
        this.host.onCommandsChanged();
      },
      () => {
        this._downloadableInFlight = false;
        this._downloadableRetryAt = Date.now() + DOWNLOADABLE_RETRY_DELAY_MS;
      },
    );
  }

  // Invoke a command by id. A convenience for keyboard shortcuts
  // (`Ctrl-Z` -> `doc.run('undo')`). No-op for an unknown id.
  async run(commandId: string): Promise<void> {
    const command = this.commands.find((c) => c.id === commandId);
    if (command) await command.run();
  }

  // Fork a new branch from a historical version and switch to it. Drives
  // the hosted version bar's "Branch from here": create the branch at
  // `fromVersion` (with the bar-supplied initial `name`, e.g. the version's
  // timestamp), then open it via the same instance-swap the branches
  // submenu's create uses. No-op without a hosted provider (offline /
  // tests) or an open doc.
  async forkFromVersion(fromVersion: number, name?: string): Promise<void> {
    const hosted = this._hostedUi;
    const docId = this.host.docId();
    if (!hosted || docId === null) return;
    const created = await this.host.createBranch({
      from_version: fromVersion,
      ...(name ? { name } : {}),
    });
    if (hosted.openSiblingDoc) {
      await hosted.openSiblingDoc(docId, { branch: created.branch_id });
    }
  }

  // Internal: lazy-build the doc-scoped built-in command list. The
  // returned `Command` objects have getters that read live state, so
  // an `enabled` / `running` change is reflected without recreating.
  private _builtins(): readonly Command[] {
    if (this._builtinCommands !== null) return this._builtinCommands;
    const hasHostedUi = (): boolean => this._hostedUi !== null;
    const editable = (): boolean => !this.host.readOnly() && this.host.isLive();
    const list: Command[] = [
      this._buildCommand(
        'history',
        DOC_COMMAND_LABELS.history,
        'document',
        DOC_COMMAND_SURFACES.history,
        hasHostedUi,
        async () => {
          const hosted = this._hostedUi;
          const docId = this.host.docId();
          if (!hosted || docId === null) return;
          const branchId = this.host.branchId();
          const result = await hosted.documentHistory(
            docId,
            branchId ? { branch: branchId } : undefined,
          );
          if (!result) return;
          // Same-branch version preview folds onto this doc in place.
          // Cross-branch / fork outcomes can't (they switch state
          // entirely), so delegate to `openSiblingDoc`. Discriminate on
          // `typeof === 'number'`, not `!== undefined`: the hosted embed
          // evolves independently, and a fork serialized as `version: null`
          // (a natural JSON shape) must not be misread as a version open,
          // which would drop the user into a read-only checkout at a bogus
          // version instead of their new editable branch.
          const version =
            typeof result.version === 'number' ? result.version : null;
          // Browse-in-the-app carries no version: it opens the host's
          // version surface where the reader already is, so it is checked
          // before the version / fork split rather than falling into the
          // fork branch on its absent version.
          if (version === null && result.browse === true) {
            this.host.browseVersions();
          } else if (version !== null && result.branch_id === branchId) {
            await this.host.checkoutVersion(version);
          } else if (hosted.openSiblingDoc) {
            await hosted.openSiblingDoc(docId, {
              branch: result.branch_id,
              ...(version !== null ? { version } : {}),
            });
          }
        },
      ),
      this._buildBranchesCommand(),
      this._buildCommand(
        'share',
        () =>
          this._downloadable
            ? SHARE_WITH_DOWNLOAD_LABEL
            : DOC_COMMAND_LABELS.share,
        'document',
        DOC_COMMAND_SURFACES.share,
        hasHostedUi,
        async () => {
          const hosted = this._hostedUi;
          const docId = this.host.docId();
          if (!hosted || docId === null) return;
          // The two surfaces are one dialog with a cross-link, so a
          // duplicate started from Share reports its copy here too.
          const outcome = await hosted.documentSettings(docId, {
            focus: 'share',
          });
          await this._openDuplicate(outcome);
        },
      ),
      // Last of the document's entries, because it is the one holding a
      // delete.
      this._buildCommand(
        'manage',
        DOC_COMMAND_LABELS.manage,
        'document',
        DOC_COMMAND_SURFACES.manage,
        hasHostedUi,
        async () => {
          const hosted = this._hostedUi;
          const docId = this.host.docId();
          if (!hosted || docId === null) return;
          // The Manage surface is rename + move + duplicate + delete in
          // one. A delete there ends via the server's `doc_gone` frame
          // (routed into `close()`); a rename is reflected by the
          // refreshName pull below.
          const outcome = await hosted.documentSettings(docId, {
            focus: 'details',
          });
          if (await this._openDuplicate(outcome)) return;
          if (hosted.refreshName) {
            const newName = await hosted.refreshName(docId);
            if (newName !== null) this.host.setName(newName);
          }
        },
      ),
      this._buildCommand(
        'undo',
        DOC_COMMAND_LABELS.undo,
        'edit',
        DOC_COMMAND_SURFACES.undo,
        () => editable() && this.host.canUndo(),
        () => {
          this.host.undo();
        },
      ),
      this._buildCommand(
        'redo',
        DOC_COMMAND_LABELS.redo,
        'edit',
        DOC_COMMAND_SURFACES.redo,
        () => editable() && this.host.canRedo(),
        () => {
          this.host.redo();
        },
      ),
    ];
    this._builtinCommands = list;
    return list;
  }

  private _reportError = (err: unknown): void => {
    if (this._onError) this._onError(commandToError(err));
    else console.error('[Brass] doc command failed:', err);
  };

  // Build a single command over the shared per-id running map, notifying
  // the host on each flip so the menu re-renders.
  private _buildCommand(
    id: string,
    label: string | (() => string),
    group: CommandGroup,
    surface: CommandSurface,
    isEnabled: () => boolean,
    impl: () => Promise<void> | void,
  ): Command {
    return makeLiveCommand(
      { id, label, group, surface, isEnabled, impl },
      {
        running: this._builtinRunning,
        onError: this._reportError,
        notify: () => this.host.onCommandsChanged(),
      },
    );
  }

  // Open the copy a settings-surface duplicate produced. The copy is a
  // different document, not another state of this one, so it goes through
  // the same coordinator a branch switch does. Reports whether it opened,
  // so a caller can skip the follow-up reads that describe the doc it just
  // navigated away from.
  private async _openDuplicate(
    outcome: DocumentSettingsResult | null,
  ): Promise<boolean> {
    const hosted = this._hostedUi;
    if (!outcome || !hosted?.openSiblingDoc) return false;
    await hosted.openSiblingDoc(outcome.newDocId, {});
    return true;
  }

  // Build the branches submenu command. The parent is always present
  // (enabled when the doc has a hostedUi provider for openSiblingDoc);
  // its children are rebuilt dynamically from `doc.branches` on every
  // access so the menu tracks branch creation / refresh reactively.
  private _buildBranchesCommand(): Command {
    const isEnabled = (): boolean => this._hostedUi !== null;
    const readRunning = (): boolean =>
      this._builtinRunning.get('branches') === true;

    const buildChild = (
      id: string,
      label: string,
      selected: boolean,
      impl: () => Promise<void> | void,
    ): Command =>
      makeLiveCommand(
        {
          id,
          label,
          group: 'document',
          surface: DOC_COMMAND_SURFACES.branches,
          selected,
          impl,
        },
        { onError: this._reportError },
      );

    const buildChildren = (): readonly Command[] => {
      const items: Command[] = [];
      const docId = this.host.docId();
      const branchId = this.host.branchId();
      for (const b of this.host.branches()) {
        const isCurrent = b.branch_id === branchId;
        items.push(
          buildChild(`branch:${b.branch_id}`, b.name, isCurrent, async () => {
            if (isCurrent) return;
            const hosted = this._hostedUi;
            if (hosted?.openSiblingDoc && docId) {
              await hosted.openSiblingDoc(docId, {
                branch: b.branch_id,
              });
            }
          }),
        );
      }
      if (this.host.hasBranchProvider() && docId !== null) {
        items.push(
          buildChild('branch:new', 'New branch...', false, async () => {
            await this.host.createBranch({});
            const branches = this.host.branches();
            const newest = branches[branches.length - 1];
            if (newest) {
              const hosted = this._hostedUi;
              if (hosted?.openSiblingDoc && docId) {
                await hosted.openSiblingDoc(docId, {
                  branch: newest.branch_id,
                });
              }
            }
          }),
        );
      }
      return items;
    };

    return {
      id: 'branches',
      label: DOC_COMMAND_LABELS.branches,
      group: 'document',
      surface: DOC_COMMAND_SURFACES.branches,
      get enabled(): boolean {
        return isEnabled();
      },
      get running(): boolean {
        return readRunning();
      },
      get children(): readonly Command[] {
        return buildChildren();
      },
      run: async (): Promise<void> => {
        const hosted = this._hostedUi;
        const docId = this.host.docId();
        if (!hosted || !docId) return;
        if (hosted.selectBranch) {
          const branchId = this.host.branchId();
          const result = await hosted.selectBranch(
            docId,
            branchId ? { branch: branchId } : undefined,
          );
          if (result && result.branch_id !== branchId && hosted.openSiblingDoc) {
            // A different branch was chosen: reopening on it reloads the
            // branch list as part of the open.
            await hosted.openSiblingDoc(docId, {
              branch: result.branch_id,
            });
          } else {
            // No switch (dialog dismissed, or the active branch re-picked).
            // The dialog can rename / set-default in place, so re-pull the
            // list; a rename of the current branch otherwise leaves the
            // branch chip + page title stale (they read the name from the
            // cached list, which the dialog never touches).
            await this.host.refreshBranches();
          }
        }
      },
    };
  }
}
