# Custom chrome

`Brass.mountToolbar` renders the whole document bar and is the
recommended path for an app that is one working surface under a bar.
This page covers the two custom shapes, from least to most custom: a
multi-pane app that builds its own header out of the **standard
pieces**, and a fully custom shell that renders `session.commands`
into its own DOM.

## Composable header pieces (multi-pane apps)

A multi-pane app (a tree beside an inspector, a list beside a preview)
builds its own header for its own layout, but should not re-implement
the account menu, presence roster, title, undo / redo, or the header's
responsive layout by hand. Take the header shell with
`Brass.mountHeader`, then drop the standard pieces into its three
slots:

```ts
// Each piece mount owns (replaces the children of) the element you
// give it, so hand each its own child within a cluster.
const slot = (parent: HTMLElement) => {
  const el = document.createElement('div');
  parent.append(el);
  return el;
};

const header = Brass.mountHeader(document.getElementById('app-header')!);
Brass.mountFileMenu(slot(header.start));     // left: file menu + title
Brass.mountDocumentTitle(slot(header.start));
Brass.mountUndoRedo(header.tools);           // middle: wraps on mobile
Brass.mountDriveSync(slot(header.end));      // right: pinned top-right
Brass.mountPresenceRoster(slot(header.end));
Brass.mountAccountMenu(slot(header.end));    // the account avatar
```

`mountHeader` gives you the same responsive bar layout `mountToolbar`
uses, from one definition: `start` ellipsizes its title rather than
wrapping, `tools` drops to its own row on a narrow screen, and `end`
stays pinned top-right, so the account avatar never wraps below the
tools on mobile (the detail a hand-rolled flex header gets wrong).
Each piece renders one cluster wired to `Brass.session` and returns
`{ destroy(): void }`; `header.destroy()` removes the shell.

- `Brass.mountFileMenu` renders the hamburger file menu (the
  `session.commands` menu surface).
- `Brass.mountDocumentTitle` renders the document title plus a
  location chip; both open the hosted location editor (rename / move /
  file). On a non-default branch the title carries a branch chip.
- `Brass.mountUndoRedo` renders undo / redo as prominent buttons.
- `Brass.mountPresenceRoster` renders the who's-here roster of
  coloured initials. It is the receiver half only: still publish your
  own presence state (see the README's "Presence").
- `Brass.mountDriveSync` renders the drive-sync badge. It renders
  nothing on a non-drive doc, so it is safe to mount in any header.
- `Brass.mountAccountMenu` renders the account avatar menu (email, an
  Open dashboard link, and sign out).

`mountHeader` already includes the historical-version preview banner
(the return-to-live strip shown while a document is previewing an
earlier version) above the bar, so a multi-pane app on the header shell
gets correct preview UX with no extra mount. Only a fully custom shell
(next section, no `mountHeader`) mounts it itself, with
`Brass.mountVersionPreview(el)`; like the drive badge it renders
nothing until there is something to show.

Mount the chrome once, when the user signs in, not per document: the
file menu has to exist in the "signed in, nothing open" state or a
fresh user has no New / Open (the same rule as `mountToolbar`).

## Fully custom shells: the command list as data

The widgets are one renderer of this same command list, so nothing
below is a different surface, just a lower-level entry point into it.

`session.commands` is the SDK's built-in actions as data: the SDK owns
each command's behavior and live state. Each carries a `surface` hint
(`'menu'` for a file menu, `'toolbar'` for a prominent button) to
filter on when placing it. It's a hint, not a constraint. The
`Command` type is exported, so type your render code against it rather
than re-declaring a local interface:

```ts
import type { Command } from '@brass-build/client';
```

The full built-in set when a doc is bound, in list order:

| `id`       | `group`    | `surface` | `label`            | Enabled when                            |
| ---------- | ---------- | --------- | ------------------ | --------------------------------------- |
| `new`      | `session`  | `menu`    | New                | Signed in.                              |
| `open`     | `session`  | `menu`    | Open...            | Signed in.                              |
| `history`  | `document` | `menu`    | Version history... | A document is open.                     |
| `branches` | `document` | `menu`    | Branches...        | A document is open. Has `children`.     |
| `share`    | `document` | `menu`    | Share... / Share / Download... | A document is open.         |
| `manage`   | `document` | `menu`    | Manage...          | A document is open.                     |
| `undo`     | `edit`     | `toolbar` | Undo               | The document is editable and there is something to undo. |
| `redo`     | `edit`     | `toolbar` | Redo               | The document is editable and there is something to redo. |

The order runs use, then manage, then destructive: `new` / `open` put a
different document on screen, `history` / `branches` put a different
state of this one there, `share` hands the document to a person or to a
file, and `manage` (the entry holding the delete) comes last. Render the
list in the order you receive it.

Each command carries `enabled` (read on every notification),
`running` (true while `run()` is in flight, drives the pending
affordance), and `run()` (always resolves; failures route to
`Brass.onError`, never throw).

Read `label` on every notification too. `share` relabels once the SDK
knows whether the document has a file to hand over, since downloading is
one row of the share dialog rather than a command of its own.

Draw a rule where `group` changes: `'session'` (a different document),
`'document'` (this document), `'edit'` (undo / redo). The widgets do
this, so a custom menu matches them by following the same rule.

A command may carry `children` (a submenu) and `selected` (the
active choice). Render a command with `children` as a submenu parent
with a disclosure chevron; render each child as a nested item,
showing a checkmark or bold style when `child.selected` is true.

Reading the list rather than hard-coding the commands you know about
means you don't miss one as the SDK adds built-ins. Filter by `surface`
to place each, and invoke one by id with `session.run('undo')` (the
hook for keyboard shortcuts).

## What each command does by default

Reading the list and calling `run()` wires all of it; you render and
invoke, the SDK owns the behavior:

- **`history`** drives version preview end to end. During a preview
  `doc.readOnly` is `true`, so gate your own edit controls on it;
  returning to live is the chrome's job (the `mountVersionPreview`
  banner), not yours.
- **`branches`** carries `children` (the branches, the active one
  `selected: true`) plus a fork-new child. Render it as a submenu and
  invoke a child's `run()`; a flat-list shell can call the parent's
  `run()` to open the hosted picker instead.
- **`share`** opens the hosted share dialog: who can open the document,
  and, where there is a file to hand over, the download.
- **`manage`** opens the same dialog on the document itself: its name,
  where it sits, Duplicate, and Delete.
- **`undo` / `redo`** call `doc.undo()` / `doc.redo()` (see "Undo,
  checkpoints, and version history" in the README).
