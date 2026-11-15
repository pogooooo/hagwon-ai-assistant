const menu = document.querySelector('.service-nav');
const selectedMenu = menu?.querySelector('[aria-current="page"]');
if (selectedMenu) {
  const overflow =
    selectedMenu.getBoundingClientRect().right -
    menu.getBoundingClientRect().right;
  if (overflow > 0) menu.scrollLeft += overflow + 16;
}

const allCorrect = document.querySelector('input[name="allCorrect"]');
if (allCorrect) {
  const wrong = allCorrect.form.querySelectorAll('input[name="wrong"]');
  allCorrect.onchange = () => {
    if (allCorrect.checked) for (const box of wrong) box.checked = false;
  };
  for (const box of wrong)
    box.onchange = () => {
      if (box.checked) allCorrect.checked = false;
    };
}

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
