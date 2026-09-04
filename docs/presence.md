# Presence (live cursors, who's-here)

`doc.presence` is the "who is here right now" layer over an open
document: the roster of other live participants plus a small per-user
`state` (cursor / camera / selection) and an app-namespaced `ext` blob.
It is non-null on any open writable `Document`, and `null` otherwise.
Presence is fully ephemeral: nothing survives a disconnect.

```ts
import type { PresenceParticipant } from '@brass-build/client';

const doc = await Brass.openDocumentById('doc_abc');

// Publish your own cursor. `set` is a partial shallow-merge and is
// throttled to ~10 Hz internally, so call it as often as you like
// (e.g. on every pointermove).
doc.presence?.set({ state: { cursor: { x, y, z } } });
doc.presence?.set({ ext: { myApp: { tool: 'select' } } });

// React to everyone else. `roster` is the other participants; each
// carries a server-stamped `displayName` + `color` (CSS-ready string,
// e.g. `'#a4c8ff'`, assign directly to `style.background` or pass to
// canvas APIs without parsing) and their last `state`. Interpolate
// between updates in your render loop.
//
// `on('change', ...)` fires once on subscribe when peers are already
// present, then on every join, leave, or `state` / `ext` update, so one
// listener covers both the initial render and every change.
const renderRoster = (roster: PresenceParticipant[]) => {
  for (const p of roster) renderAvatar(p.connectionId, p.color, p.state);
};
const stop = doc.presence?.on('change', renderRoster);

// `doc.close()` tears presence down for you; call `leave()` directly
// only if you want to drop presence while keeping the doc open.
doc.presence?.leave();
```

## Coordinate convention

The `state` block uses a fixed coordinate convention so participants
stay legible across different apps over the same document: **meters,
right-handed, Z-up, document world space**. Map your engine's
coordinates into it before `set` and back out when rendering remote
participants. The `roster` is keyed on `connectionId`, so one user
in two tabs shows as two participants.

## Reserved `state` sub-keys

App-set but reserved-by-convention so two apps subscribed to the
same document agree on what each key means. Pick from this set in
preference to inventing new ones:

```ts
interface PresenceState {
  // The user's primary pointer position in the document's world
  // space. Use for "this is where my cursor is right now" in a 2D
  // or 3D editor. Omit if your app has no cursor concept.
  cursor?: { x: number; y: number; z: number };
  // Where the user is looking from in 3D. Use to render a
  // "Bob is viewing the south facade" gizmo at the camera's
  // position. Omit in 2D apps; use `cursor` instead.
  camera?: {
    position: { x: number; y: number; z: number };
    target?: { x: number; y: number; z: number };
  };
  // The entity ids the user has selected. Use to highlight remote
  // selections so collaborators see what each other is working on.
  selection?: string[];
  // Where the user's caret sits in a text container. `key` names the
  // container (`doc.text(key)`), and both offsets count UTF-16 code
  // units into its value: `anchor` where the selection began, `head`
  // where it is now, equal for a plain caret. Use it to draw remote
  // carets in prose, the way `selection` highlights picked entities.
  textCaret?: { key: string; anchor: number; head: number };
}
```

A caret belongs in `state` rather than in `ext` for the same reason a
selection does: a document of prose is often open in more than one app,
and a reader wants to see where the other person is working whichever
app they are each in. Publish it on every selection change, which the
10 Hz debounce already paces.

App-specific state (the current tool, a chat bubble, a typing
indicator) goes under `ext` instead so it stays namespaced and out of
the cross-app conventions. The `ext` block is otherwise free-form:
`ext.myApp = { tool: 'select', chatBubble: 'hi' }`.

## How much you can publish

Each layer is capped at 2,048 bytes of serialised JSON, exported as
`PRESENCE_LAYER_MAX_BYTES`. Brass measures the two layers separately, so a
large `ext` blob leaves `state` its full budget.

`selection` is the field that reaches the cap in ordinary use, because it
grows with what the user picked, and one marquee select crosses it.
Publish a bounded summary when a selection can get large, such as the
first few ids plus a count, or the selection's bounding box.

The SDK measures each layer before it sends and withholds one that is over
the cap, so peers keep the last value that fit rather than losing it. Read
`presence.status` for the current answer, or subscribe with `onStatus`:

```ts
doc.presence?.onStatus((status) => {
  if (status.oversize) {
    showNotice(`Not sharing your ${status.withheld.join(' and ')}`);
  } else {
    clearNotice();
  }
});
```

`onStatus` fires on attach and then whenever the answer changes, so an app
publishing an oversized payload at 10 Hz hears about it once.

## Types

`doc.presence` is typed `PresenceClient | null`. Each `roster` entry
is a `PresenceParticipant` with
`{ connectionId, sub, displayName, avatarUrl, color, joinedAt, lastSeen,
state, ext }`. `displayName`, `avatarUrl`, and `color` are always
present as strings, and `avatarUrl` is `''` when the user has no
picture. Both types are exported from `@brass-build/client`, alongside
`PresenceSetInput` and `PresenceChangeListener`, for annotating your
handlers and roster state.

## Hand-rolling the header roster (custom shell)

`Brass.mountToolbar` and `Brass.mountPresenceRoster` render the
who's-here roster of coloured initials for you, so prefer those. When
you build a fully custom shell and want the roster in your own element,
render it from `doc.presence.roster`, a small list of coloured
initials that renders the same way for every app:

```ts
import type { PresenceParticipant } from '@brass-build/client';

const renderRoster = (roster: readonly PresenceParticipant[]): void => {
  const el = document.getElementById('roster')!;
  el.replaceChildren(...roster.map((p) => {
    const pip = document.createElement('span');
    pip.className = 'pip';
    pip.style.background = p.color;
    pip.title = p.displayName;
    if (p.avatarUrl) {
      const img = document.createElement('img');
      img.src = p.avatarUrl;
      img.alt = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
      pip.appendChild(img);
    } else {
      pip.textContent = p.displayName.slice(0, 1).toUpperCase();
    }
    return pip;
  }));
};
```

Drive it from the same `change` subscription as the in-surface remote
cursors (see the README's "Presence" section). The listener fires on
subscribe whenever peers are already present, so it paints the initial
roster for you. Render `doc.presence?.roster ?? []` yourself to put the
empty state on screen before anyone joins.
