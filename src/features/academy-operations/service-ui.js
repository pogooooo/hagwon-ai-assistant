const menu = document.querySelector('.service-nav');
const selectedMenu = menu?.querySelector('[aria-current="page"]');
if (selectedMenu) {
  const overflow =
    selectedMenu.getBoundingClientRect().right -
    menu.getBoundingClientRect().right;
  if (overflow > 0) menu.scrollLeft += overflow + 16;
}

// Restore only the failed schedule form; keep the server's fresh revision token.
const restoredSchedule = document.querySelector('[data-restore-schedule]');
if (restoredSchedule) {
  const values = new URLSearchParams(
    JSON.parse(restoredSchedule.dataset.restoreSchedule),
  );
  const action = values.get('action');
  for (const form of document.querySelectorAll('form[method="post"]')) {
    if (
      ![...form.querySelectorAll('[name="action"]')].some(
        (el) => el.value === action,
      )
    )
      continue;
    if (
      (form.elements.namedItem('eventId')?.value || '') !==
      (values.get('eventId') || '')
    )
      continue;
    for (const el of form.querySelectorAll('input, select, textarea')) {
      if (
        !el.name ||
        ['version', 'action', 'revision'].includes(el.name) ||
        el.type === 'file'
      )
        continue;
      if (el.type === 'checkbox' || el.type === 'radio')
        el.checked = values.getAll(el.name).includes(el.value);
      else if (values.has(el.name)) el.value = values.get(el.name);
    }
    const details = form.closest('details');
    if (details) details.open = true;
  }
}

for (const form of document.querySelectorAll('#makeup form')) {
  const classSelect = form.querySelector('select[name="classId"]');
  const studentSelect = form.querySelector('select[name="studentId"]');
  if (classSelect && studentSelect) {
    const filterStudents = () => {
      for (const option of studentSelect.options) {
        const allowed =
          !option.value ||
          JSON.parse(option.dataset.classIds || '[]').includes(
            classSelect.value,
          );
        option.hidden = !allowed;
        option.disabled = !allowed;
        if (!allowed && option.selected) studentSelect.value = '';
      }
    };
    classSelect.addEventListener('change', filterStudents);
    filterStudents();
  }
  const previewAction = [...form.querySelectorAll('[name="action"]')].find(
    (el) => ['create', 'change', 'class-config'].includes(el.value),
  )?.value;
  if (!previewAction) continue;
  const status = document.createElement('p');
  status.className = 'muted';
  status.setAttribute('role', 'status');
  form.append(status);
  let timer, controller;
  form.addEventListener('input', () => {
    clearTimeout(timer);
    controller?.abort();
    status.textContent = '';
    timer = setTimeout(async () => {
      if (!form.checkValidity()) return;
      const fields = new FormData(form);
      fields.set('action', previewAction);
      if (previewAction === 'create' && !fields.get('makeupDate')) return;
      controller = new AbortController();
      const current = controller;
      status.textContent = '일정 충돌 확인 중…';
      try {
        const result = await fetch('/schedule?preview=1', {
          method: 'POST',
          body: fields,
          signal: current.signal,
        });
        const data = await result.json();
        if (!current.signal.aborted) status.textContent = data.message;
      } catch {
        if (!current.signal.aborted)
          status.textContent =
            '미리 확인하지 못했습니다. 저장 시 다시 확인합니다.';
      }
    }, 400);
  });
}

const documentUpload = document.querySelector('[data-document-upload]');
if (documentUpload) {
  documentUpload.addEventListener('submit', () => {
    const progress = documentUpload.querySelector('[data-document-progress]');
    if (documentUpload.elements.namedItem('file').files.length) {
      progress.hidden = false;
      documentUpload.querySelector('button[type="submit"]').disabled = true;
    }
  });
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
