// Keep an unsent question only in this browser tab and only for this account.
const account = document.body.dataset.account;
if (account) {
  const key = 'axr-draft:' + account;
  const field = document.querySelector(
    '.chat-composer textarea[name="question"]',
  );
  try {
    if (field) {
      if (!field.value) field.value = sessionStorage.getItem(key) || '';
      field.addEventListener('input', () =>
        sessionStorage.setItem(key, field.value),
      );
      field.form.addEventListener('submit', () =>
        sessionStorage.removeItem(key),
      );
    }
    document
      .querySelector('form[action="/logout"]')
      ?.addEventListener('submit', () => sessionStorage.removeItem(key));
  } catch {
    /* Storage is optional; the form works without it. */
  }
}
