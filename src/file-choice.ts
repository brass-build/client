// The browser's own file dialog, for a visitor with no account: there is
// nothing of theirs to browse, so which file is the whole question.
//
// `input.click()` needs the user activation of the press that called it,
// which lasts seconds rather than a task, so a short read may come first.
// Resolves null when the dialog is dismissed (`cancel`, which every current
// engine fires on an `<input type=file>`).

export function chooseFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (accept !== '') input.accept = accept;
    input.style.display = 'none';
    const finish = (file: File | null): void => {
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    // Attached, because a detached input does not open its dialog in every
    // engine.
    document.body.append(input);
    input.click();
  });
}
