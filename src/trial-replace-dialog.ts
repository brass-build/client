// The prompt shown before New or Upload replaces a document a visitor made
// without an account and has edited. Signing in is what keeps it: the
// document is claimed into the account the visitor signs in with.
//
// SDK-rendered for the same reasons as the schema-conflict prompt: it asks
// one question about the document already on this page and needs no session.

export type TrialReplaceChoice = 'sign-in' | 'leave' | 'cancel';

const DAY_MS = 24 * 60 * 60 * 1000;

const STYLE = `
.brass-tr-backdrop {
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
.brass-tr-backdrop::backdrop {
  background: transparent;
}
.brass-tr-panel {
  background: Canvas;
  color: CanvasText;
  color-scheme: light dark;
  max-width: 26rem;
  width: 100%;
  padding: 1.25rem;
  border-radius: 0.75rem;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.28);
}
.brass-tr-title {
  margin: 0 0 0.5rem;
  font-size: 1.0625rem;
  font-weight: 600;
}
.brass-tr-body {
  margin: 0 0 1.25rem;
}
.brass-tr-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 0.5rem;
}
.brass-tr-actions button {
  font: inherit;
  min-height: 2.5rem;
  padding: 0 0.875rem;
  border-radius: 0.375rem;
  border: 1px solid rgba(128, 128, 128, 0.4);
  background: transparent;
  color: inherit;
  cursor: pointer;
}
.brass-tr-actions button.brass-tr-go {
  border-color: transparent;
  background: CanvasText;
  color: Canvas;
}
`;

/** The prompt's sentence for a document the platform removes at `expiresAt`. */
export function trialReplaceMessage(expiresAt: Date, now: number = Date.now()): string {
  const days = Math.max(1, Math.ceil((expiresAt.getTime() - now) / DAY_MS));
  return (
    'You are not signed in, so your work is kept only at its link. ' +
    `It will be removed in ${days} ${days === 1 ? 'day' : 'days'}. ` +
    'Sign in to keep it in your account.'
  );
}

/**
 * Ask whether to sign in before leaving an edited document. Resolves
 * `'cancel'` on Cancel, on Escape, and when there is no DOM to ask in, since
 * each of those leaves the document on screen.
 */
export function askReplaceTrial(expiresAt: Date): Promise<TrialReplaceChoice> {
  if (typeof document === 'undefined') return Promise.resolve('cancel');
  return new Promise<TrialReplaceChoice>((resolve) => {
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;

    const backdrop = document.createElement('dialog');
    backdrop.className = 'brass-tr-backdrop';
    const panel = document.createElement('div');
    panel.className = 'brass-tr-panel';
    panel.setAttribute('role', 'alertdialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'brass-tr-title');

    const titleEl = document.createElement('h2');
    titleEl.className = 'brass-tr-title';
    titleEl.id = 'brass-tr-title';
    titleEl.textContent = 'Keep your work?';

    const body = document.createElement('p');
    body.className = 'brass-tr-body';
    body.textContent = trialReplaceMessage(expiresAt);

    const actions = document.createElement('div');
    actions.className = 'brass-tr-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const leave = document.createElement('button');
    leave.type = 'button';
    leave.textContent = 'Continue without it';
    const signIn = document.createElement('button');
    signIn.type = 'button';
    signIn.className = 'brass-tr-go';
    signIn.textContent = 'Sign in';

    const opener =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;

    let settled = false;
    const settle = (choice: TrialReplaceChoice): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      if (backdrop.open) backdrop.close();
      host.remove();
      if (opener?.isConnected) opener.focus();
      resolve(choice);
    };
    function onKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') settle('cancel');
    }

    cancel.addEventListener('click', () => settle('cancel'));
    leave.addEventListener('click', () => settle('leave'));
    signIn.addEventListener('click', () => settle('sign-in'));
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('cancel', (event) => {
      event.preventDefault();
      settle('cancel');
    });

    actions.append(cancel, leave, signIn);
    panel.append(titleEl, body, actions);
    backdrop.append(panel);
    shadow.append(style, backdrop);
    document.body.append(host);
    if (typeof backdrop.showModal === 'function') backdrop.showModal();
    // Cancel leaves everything as it was, so it takes focus: Enter on a
    // prompt nobody read keeps the document on screen.
    cancel.focus();
  });
}
