const mobileMenu = document.querySelector('#mobile-menu');
for (const suggestion of document.querySelectorAll('[data-question]')) {
  suggestion.addEventListener('click', () => {
    const question = document.querySelector(
      '.chat-composer textarea[name="question"]',
    );
    if (!question) return;
    question.value = suggestion.dataset.question;
    question.dispatchEvent(new Event('input', { bubbles: true }));
    question.focus();
    question.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
}
const composer = document.querySelector('.chat-composer');
composer?.addEventListener('submit', (event) => {
  if (composer.getAttribute('aria-busy') === 'true') {
    event.preventDefault();
    return;
  }
  composer.setAttribute('aria-busy', 'true');
  // Keep the submitter enabled so its action=ask value is sent by the browser.
  const status = composer.querySelector('.chat-progress');
  if (status)
    status.textContent = composer.hasAttribute('data-makeup-composer')
      ? '겹치지 않는 보강 시간을 찾고 있어요.'
      : '학원 자료에서 답변을 확인하고 있어요. 잠시 기다려 주세요.';
});
window.addEventListener('pageshow', () => {
  composer?.removeAttribute('aria-busy');
  const status = composer?.querySelector('.chat-progress');
  if (status) status.textContent = '';
});
document
  .querySelector('[data-open-menu]')
  ?.addEventListener('click', () => mobileMenu?.showModal());
mobileMenu?.addEventListener('click', (event) => {
  if (event.target === mobileMenu) {
    const box = mobileMenu.getBoundingClientRect();
    if (
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom
    )
      mobileMenu.close();
  }
});
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/service-worker.js').catch(() => {
    // Installation is optional; normal online operation remains available.
  });
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
  const scopeSelect = form.querySelector('select[name="scope"]');
  if (classSelect && studentSelect) {
    if (scopeSelect) {
      const setStudentField = () => {
        const individual = scopeSelect.value === 'student';
        studentSelect.closest('label').hidden = !individual;
        studentSelect.disabled = !individual;
        studentSelect.required = individual;
      };
      scopeSelect.addEventListener('change', setStudentField);
      setStudentField();
    }
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
  const uploadButton = documentUpload.querySelector('button[type="submit"]');
  let imageVersion = 0;
  documentUpload.elements
    .namedItem('file')
    .addEventListener('change', async (event) => {
      const input = event.target,
        file = input.files[0],
        version = ++imageVersion;
      const status = documentUpload.querySelector('[data-image-status]');
      input.setCustomValidity('');
      status.textContent = '';
      const title = documentUpload.elements.namedItem('title');
      if (!title.value.trim() && file)
        title.value = file.name.replace(/\.[^.]+$/, '').slice(0, 200);
      if (!file || !/\.(png|jpe?g|webp|bmp)$/i.test(file.name)) {
        uploadButton.disabled = false;
        return;
      }
      uploadButton.disabled = true;
      input.setCustomValidity('사진을 준비하고 있습니다.');
      status.textContent = '사진을 준비하고 있습니다…';
      let bitmap;
      try {
        if (file.size > 20 * 1024 * 1024)
          throw new Error('사진은 20MB 이하로 골라 주세요.');
        bitmap = await createImageBitmap(file, {
          imageOrientation: 'from-image',
        });
        if (version !== imageVersion) return;
        if (
          Math.min(bitmap.width, bitmap.height) < 4 ||
          Math.max(bitmap.width / bitmap.height, bitmap.height / bitmap.width) >
            5
        )
          throw new Error(
            '너무 길거나 작은 사진은 읽기 어렵습니다. 문서 영역을 나눠 찍어 주세요.',
          );
        const scale = Math.min(1, 2240 / Math.max(bitmap.width, bitmap.height));
        if (scale < 1 || file.size > 4 * 1024 * 1024) {
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(4, Math.round(bitmap.width * scale));
          canvas.height = Math.max(4, Math.round(bitmap.height * scale));
          const context = canvas.getContext('2d');
          context.fillStyle = '#ffffff';
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
          const blob = await new Promise((resolve) =>
            canvas.toBlob(resolve, 'image/jpeg', 0.94),
          );
          if (version !== imageVersion) return;
          if (!blob)
            throw new Error(
              '사진을 준비하지 못했습니다. JPG 또는 PNG로 저장해 주세요.',
            );
          const files = new DataTransfer();
          files.items.add(
            new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', {
              type: 'image/jpeg',
            }),
          );
          input.files = files.files;
          status.textContent =
            '등록용 사진을 자동으로 줄였습니다. 기기의 원본은 그대로 유지됩니다.';
        } else status.textContent = '사진을 등록할 수 있습니다.';
        input.setCustomValidity('');
      } catch (error) {
        if (version !== imageVersion) return;
        const message =
          error instanceof Error && !/decode|source|bitmap/i.test(error.message)
            ? error.message
            : '사진을 열 수 없습니다. JPG·PNG·WEBP·BMP로 저장해 주세요.';
        input.setCustomValidity(message);
        status.textContent = message;
      } finally {
        bitmap?.close();
        if (version === imageVersion) uploadButton.disabled = false;
      }
    });
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

for (const form of document.querySelectorAll('[data-wrong-form]')) {
  const picks = [...form.querySelectorAll('[name="wrong"]')];
  const all = form.elements.namedItem('allCorrect');
  const summary = form.querySelector('.selection-summary');
  const picker = form.querySelector('[data-page-picker]');
  if (picker) {
    picker.hidden = false;
    const select = picker.querySelector('select');
    const showPage = () => {
      for (const group of form.querySelectorAll('[data-question-page]'))
        group.hidden = group.dataset.questionPage !== select.value;
    };
    select.addEventListener('change', showPage);
    showPage();
  }
  function update(event) {
    if (event?.target === all && all.checked)
      for (const pick of picks) pick.checked = false;
    if (event?.target.name === 'wrong' && event.target.checked)
      all.checked = false;
    const chosen = picks.filter((el) => el.checked);
    summary.hidden = false;
    summary.textContent = chosen.length
      ? '선택한 오답 · ' + chosen.map((el) => el.dataset.answerLabel).join(', ')
      : all.checked
        ? '모두 맞음'
        : '선택한 오답이 없습니다.';
    const submit = form.querySelector('button[type="submit"]');
    submit.textContent = chosen.length
      ? '오답 ' + chosen.length + '개 제출'
      : all.checked
        ? '모두 맞음 제출'
        : '결과 제출';
    submit.disabled = !chosen.length && !all.checked;
  }
  form.addEventListener('change', update);
  update();
}

const transcript = document.querySelector('.conversation-messages');
if (
  transcript &&
  !location.hash &&
  transcript.scrollHeight > transcript.clientHeight
) {
  transcript.scrollTop = transcript.scrollHeight;
}

document
  .querySelector('[data-briefing-filters]')
  ?.addEventListener('change', (event) => {
    const form = event.currentTarget;
    if (event.target.name === 'class') {
      form.elements.namedItem('student').value = '';
      const assignment = form.elements.namedItem('workbook');
      if (assignment) assignment.value = '';
    }
    if (['class', 'student'].includes(event.target.name)) form.requestSubmit();
  });

document
  .querySelector('[data-print-exam]')
  ?.addEventListener('click', () => window.print());
