// The prompt shown when the platform refuses to open a document this app's
// declared schema cannot read.
//
// SDK-rendered rather than a hosted iframe: it asks one question about a
// document already named on this page, needs no session of its own, and has
// to appear on a cold boot from a bookmark, which is the moment an iframe
// round-trip is least welcome. The hosted dialogs exist for surfaces that
// read the person's whole account; this reads nothing.
//
// Both strings are the server's own, rendered verbatim. A client compiles
// into an app's bundle and freezes there, so a word this file holds itself
// can only be corrected by every app republishing, while a word it is handed
// reaches every app the moment the platform deploys. The fallback below is
// for a platform that predates the title, not a second opinion about wording.

export interface SchemaConflictChoice {
  openAnyway: boolean;
}

const STYLE = `
/* A dialog opened with showModal(), so the browser holds the keyboard inside
   the prompt. The UA box styles for a dialog (content-sized, centered,
   bordered, padded, max-width capped) are all wrong for a full-viewport
   backdrop, so each is zeroed, and the UA backdrop is cleared because this
   element paints the dim itself. */
.brass-sc-backdrop {
  position: fixed;
  inset: 0;
  margin: 0;
  border: 0;
  width: auto;
  height: auto;
  max-width: none;
  max-height: none;
  z-index: 2147483646;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(20, 18, 13, 0.45);
  font: 15px/1.5 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
}
.brass-sc-backdrop::backdrop {
  background: transparent;
}
.brass-sc-panel {
  background: Canvas;
  color: CanvasText;
  color-scheme: light dark;
  max-width: 26rem;
  width: 100%;
  padding: 1.25rem;
  border-radius: 0.75rem;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
}
.brass-sc-title {
  margin: 0 0 0.5rem;
  font-size: 1.0625rem;
  font-weight: 600;
}
.brass-sc-body {
  margin: 0 0 1.25rem;
}
.brass-sc-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}
.brass-sc-actions button {
  font: inherit;
  min-height: 2.5rem;
  padding: 0 0.875rem;
  border-radius: 0.375rem;
  border: 1px solid rgba(128, 128, 128, 0.4);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.brass-sc-actions button.brass-sc-go {
  border-color: transparent;
  background: CanvasText;
  color: Canvas;
}
`;

/**
 * Ask whether to open the document anyway. Resolves `openAnyway: false` on
 * Close, on Escape, and when there is no DOM to ask in: every one of those is
 * an open nobody agreed to, and the refusal stands.
 */
export function askSchemaConflict(
  message: string,
  title?: string,
): Promise<SchemaConflictChoice> {
  if (typeof document === 'undefined') {
    return Promise.resolve({ openAnyway: false });
  }
  return new Promise<SchemaConflictChoice>((resolve) => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;

    const backdrop = document.createElement('dialog');
    backdrop.className = 'brass-sc-backdrop';
    const panel = document.createElement('div');
    panel.className = 'brass-sc-panel';
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'brass-sc-title');

    const titleEl = document.createElement('h2');
    titleEl.className = 'brass-sc-title';
    titleEl.id = 'brass-sc-title';
    titleEl.textContent = title ?? 'This app may not read this file correctly';

    const body = document.createElement('p');
    body.className = 'brass-sc-body';
    body.textContent = message;

    const actions = document.createElement('div');
    actions.className = 'brass-sc-actions';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = 'Close';
    const go = document.createElement('button');
    go.type = 'button';
    go.className = 'brass-sc-go';
    go.textContent = 'Open anyway';

    // Where the reader was when the prompt opened. Answering it detaches the
    // prompt rather than closing it in place, so putting them back is this
    // function's job.
    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    let settled = false;
    const settle = (openAnyway: boolean): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      if (backdrop.open) backdrop.close();
      host.remove();
      if (opener?.isConnected) opener.focus();
      resolve({ openAnyway });
    };
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') settle(false);
    }

    close.addEventListener('click', () => settle(false));
    go.addEventListener('click', () => settle(true));
    document.addEventListener('keydown', onKey, true);
    // An open dialog answers Escape itself, which would close it without
    // resolving. Route it into the one answer path; `onKey` above normally
    // gets there first.
    backdrop.addEventListener('cancel', (event) => {
      event.preventDefault();
      settle(false);
    });

    actions.append(close, go);
    panel.append(titleEl, body, actions);
    backdrop.append(panel);
    shadow.append(style, backdrop);
    document.body.append(host);
    // The call that holds the keyboard inside the prompt: without it Tab keeps
    // walking the app behind it. Guarded so a browser without the top layer
    // still gets the prompt, non-modal, rather than none.
    if (typeof backdrop.showModal === 'function') backdrop.showModal();
    // Close is the safe answer, so it takes focus: Enter on a dialog nobody
    // read declines rather than opening a document the platform refused.
    close.focus();
  });
}
