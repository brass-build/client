# Text fields

`doc.text(key)` is the container for prose several people edit at once. The
[README](../README.md#prose-several-people-edit) covers what it is and how
to wire a field to it. This page covers what a real editor needs on top:
painting a peer's edit without throwing away the caret, the IME window,
what a keystroke costs, and where a text container belongs in a document.

## Paint a peer's edit without losing the caret

Assigning `field.value` moves the caret to the end, so an editor that
assigns unconditionally throws away the reader's place on every peer
keystroke, and one that skips a focused field never shows a peer's typing
to anyone who is typing themselves. Find the span the incoming value
replaced, and move the caret across it:

```ts
const report = doc.text('report');
let painted = report.read();
field.value = painted;

report.subscribe((value, origin) => {
  if (origin?.source === 'local') { painted = value; return; }
  if (value === painted) return;

  // The one span that differs, found by trimming the common prefix and
  // the common suffix. A keystroke, a paste, and a peer's edit each look
  // like this.
  const max = Math.min(painted.length, value.length);
  let start = 0;
  while (start < max && painted.charCodeAt(start) === value.charCodeAt(start)) start += 1;
  let tail = 0;
  while (tail < max - start
         && painted.charCodeAt(painted.length - 1 - tail)
            === value.charCodeAt(value.length - 1 - tail)) tail += 1;
  const removed = painted.length - tail - start;
  const inserted = value.length - tail - start;

  // The caret binds to the text on its right, so a peer typing where it
  // sits pushes it past what they wrote and leaves it in front of the same
  // words. One before the span does not move, one after it shifts by the
  // span's change in length.
  const carry = (caret: number): number =>
    caret < start ? caret
    : caret >= start + removed ? caret + inserted - removed
    : start + Math.min(caret - start, inserted);

  // A reader with text selected has two offsets, and `selectionDirection`
  // says which of them their next keystroke extends from.
  const focused = document.activeElement === field;
  const anchor = carry(field.selectionStart ?? 0);
  const head = carry(field.selectionEnd ?? field.selectionStart ?? 0);
  const direction = field.selectionDirection;
  // Assigning `value` resets the scroll, which throws a reader who is
  // partway down a long field back to the top on every peer keystroke.
  const scroll = field.scrollTop;

  field.value = value;
  painted = value;
  field.scrollTop = scroll;
  if (focused) {
    field.setSelectionRange(nudgeOffPair(value, anchor), nudgeOffPair(value, head), direction);
  }
});
```

Offsets count UTF-16 code units, which is what a text field's
`selectionStart` reports, so the two agree with no conversion. The same
units are why an offset needs one more check before it is used: a character
outside the Basic Multilingual Plane, an emoji above all, is two code units,
and the `charCodeAt` walk above stops between them whenever the edit sits
next to one. `nudgeOffPair` moves such an offset off the seam:

```ts
function nudgeOffPair(text: string, at: number): number {
  const bounded = Math.max(0, Math.min(at, text.length));
  if (bounded <= 0 || bounded >= text.length) return bounded;
  const before = text.charCodeAt(bounded - 1);
  const after = text.charCodeAt(bounded);
  const splits = before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff;
  return splits ? bounded - 1 : bounded;
}
```

Restoring the selection only while the field is focused keeps the paint
from setting a selection nobody asked for, and from scrolling an offscreen
field into view.

`origin` carries who wrote the change, the way a map subscriber's does:
`local`, `remote`, `undo`, or `redo`, and undefined on a fire describing no
authored transition (registration, and the catch-up a version checkout
produces). Splitting on `local` is what keeps this work off the typing
path, where it would otherwise run on every keystroke.

## Defer the paint, not the write, while an IME is open

Assigning to the field while an IME is open discards what it is holding,
which costs a reader typing Japanese, Chinese, or Korean the word they were
in the middle of. So track `compositionstart` / `compositionend` and skip
the paint in between.

Keep writing through `update` the whole time. `input` fires during a
composition, the write touches no DOM, and the container merges it with
whatever a peer sends meanwhile:

```ts
let composing = false;
let missed = false;

field.addEventListener('compositionstart', () => { composing = true; });
field.addEventListener('compositionend', () => {
  composing = false;
  painted = field.value;
  report.update(painted);
  // What arrived while the composition was open is older than what the
  // reader just committed, so paint the container's own value, which
  // carries both.
  if (missed) {
    missed = false;
    const latest = report.read();
    if (latest !== painted) paintPeerEdit(latest);
  }
});
```

Holding the incoming value and applying it at `compositionend` is the
version that looks right and loses data: that value predates the
composition, so painting it discards the word the reader just committed.
Deferring the write instead has the same shape of bug one layer down, since
the field's value then has no record of the peer's edit and `update` diffs
it back out.

## Publish the caret too

`state.textCaret` in [`presence.md`](./presence.md) is
`{ key, anchor, head }`: the container the caret sits in, and its two
offsets in the same UTF-16 code units this page uses. Publishing it on
every selection change lets peers draw where you are working, and the 10 Hz
presence debounce already paces it.

## What a keystroke costs

`update` compares against the whole stored string to find the smallest
edit, so its cost scales with the field's own length. Measured through the
handle on a 2.1 GHz core, after 20,000 edits, typing at a realistic
revision pattern:

| field | ms per keystroke |
| --- | --- |
| 20 KB | 0.72 |
| 100 KB | 1.72 |
| 300 KB | 4.09 |

One paragraph, one description, or one report is far inside a frame at
typing speed. A field holding a book is not, and an app whose document
grows that large wants its prose split across containers, one per section,
so an edit compares against a section rather than the book.

A second, smaller term grows with the document's accumulated edit history,
because materializing a text container costs more as its rope fragments.
Composing sentences barely fragments it (20,000 keystrokes on a 20 KB field
stay at 0.46 ms and leave a 2 KB snapshot); revising in short runs across
the field reaches 0.64 ms. The history term is permanent rather than
per-session, since a snapshot carries the history.

## One root per document-shaped thing, not per row

A text container is a top-level root, and no nested-text surface exists, so
per-element prose that merges costs one root per element. Loro prices a
container against how many the document holds, so that does not stay flat
the way the record store does, where paging holds container count down past
`UNPAGED_MAX_RECORDS`. Creating one text root per element against the same
elements written as records:

| elements | a root each | as records | roots heap | records heap |
| --- | --- | --- | --- | --- |
| 5,000 | 599 ms | 403 ms | 27 MB | 3 MB |
| 10,000 | 1,460 ms | 182 ms | 52 MB | 2 MB |
| 20,000 | 9,318 ms | 404 ms | 104 MB | 3 MB |
| 40,000 | 26,419 ms | 1,206 ms | 194 MB | 10 MB |

Registering a subscriber costs the same per root, so an editor that shows
every row's note pays that cost again on every open.

So prose that belongs to each row of a repeated collection stays in the
row's record, where the row is the merge unit. Two people typing in one
row's note then keep one of the two, which is the trade a repeated
collection makes. Where one particular row is the thing people write
together, give that row's prose a root of its own and leave the rest in the
store. Roots in the hundreds are cheap; the curve is what decides, not a
fixed cap.
