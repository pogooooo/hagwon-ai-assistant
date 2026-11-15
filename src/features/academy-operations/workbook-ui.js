(() => {
  const photo = document.querySelector('#workbook-photo');
  const save = document.querySelector('#workbook-save');
  const rows = document.querySelector('#workbook-rows');
  const template = document.querySelector('#workbook-row');
  const preview = document.querySelector('#workbook-preview');
  const status = document.querySelector('#workbook-status');
  const subject = photo.elements.subject;
  let previewUrl = '';
  let busy = false;
  function updateClasses() {
    const select = save.elements.classId;
    for (const option of select.options) {
      option.hidden = option.disabled =
        option.dataset.subject !== subject.value;
    }
    if (!select.selectedOptions.length || select.selectedOptions[0].disabled)
      select.value = [...select.options].find((o) => !o.disabled)?.value ?? '';
  }
  function lock(locked) {
    busy = locked;
    for (const form of [photo, save]) form.inert = locked;
    photo.setAttribute('aria-busy', String(locked));
  }
  function defaults() {
    return {
      book: photo.elements.book.value.trim(),
      page: Number(photo.elements.page.value),
      segment: photo.elements.segment.value.trim(),
      number: '',
      type: '',
    };
  }
  function add(item) {
    const row = template.content.firstElementChild.cloneNode(true);
    for (const input of row.querySelectorAll('[data-field]'))
      input.value = item[input.dataset.field] ?? '';
    row.dataset.source = item.sourceId ?? '';
    const reading = row.querySelector('[data-reading]');
    reading.textContent = item.sourceId
      ? [
          item.text || '원문 판독 불가',
          item.status === 'classified'
            ? 'AI 유형 · ' + item.type
            : {
                no_adopted: '채택 태그 없음',
                unreadable: '읽기 불가',
                out_of_scope: '분류 범위 밖',
              }[item.status],
        ]
          .filter(Boolean)
          .join(' / ')
      : '';
    reading.hidden = !reading.textContent;
    row.querySelector('[data-select]').onchange = (e) => {
      for (const input of row.querySelectorAll('[data-field]'))
        input.disabled = !e.target.checked;
      changed();
    };
    row.querySelector('[data-remove]').onclick = () => {
      row.remove();
      changed();
    };
    rows.append(row);
    changed();
    return row;
  }
  function changed() {
    save.elements.reviewed.checked = false;
    subject.disabled = !!rows.querySelector(
      '[data-source]:not([data-source=""])',
    );
  }
  function clearPhoto() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    preview.removeAttribute('src');
    preview.hidden = true;
  }
  photo.elements.photo.onchange = () => {
    clearPhoto();
    const file = photo.elements.photo.files[0];
    if (file) {
      previewUrl = URL.createObjectURL(file);
      preview.src = previewUrl;
      preview.hidden = false;
    }
  };
  subject.onchange = updateClasses;
  updateClasses();
  rows.oninput = changed;
  document.querySelector('#workbook-add').onclick = () => {
    add(defaults()).querySelector('[data-field="number"]').focus();
  };
  async function errorMessage(response) {
    const html = await response.text();
    return (
      new DOMParser()
        .parseFromString(html, 'text/html')
        .querySelector('[role="alert"]')?.textContent ||
      '요청을 처리하지 못했습니다. 로그인 상태를 확인해 주세요.'
    );
  }
  photo.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(photo);
    form.set('subject', subject.value);
    const page = defaults();
    lock(true);
    status.textContent = '사진을 판독하고 문항을 분류하고 있습니다.';
    try {
      const response = await fetch('/homework?analyze=1', {
        method: 'POST',
        body: form,
      });
      if (
        !response.ok ||
        !response.headers.get('content-type')?.includes('application/json')
      )
        throw Error(await errorMessage(response));
      const items = await response.json();
      for (const item of items) add({ ...page, ...item });
      photo.elements.page.value = Math.min(100000, page.page + 1);
      photo.elements.photo.value = '';
      status.textContent =
        page.page +
        '쪽에서 ' +
        items.length +
        '문항을 추가했습니다. 원본과 대조하거나 다음 쪽을 분석하세요.';
    } catch (e) {
      status.textContent = e.message;
    } finally {
      lock(false);
    }
  };
  save.onsubmit = async (event) => {
    event.preventDefault();
    if (busy) return;
    const items = [];
    for (const row of rows.children) {
      if (!row.querySelector('[data-select]').checked) continue;
      const item = { sourceId: row.dataset.source || null };
      for (const input of row.querySelectorAll('[data-field]'))
        item[input.dataset.field] =
          input.dataset.field === 'page'
            ? Number(input.value)
            : input.value.trim();
      if (
        !item.book ||
        !item.number ||
        !Number.isInteger(item.page) ||
        item.page < 1 ||
        item.page > 100000
      ) {
        status.textContent = '선택한 문항의 교재·쪽·번호를 확인해 주세요.';
        return;
      }
      items.push(item);
    }
    if (!items.length || items.length > 300) {
      status.textContent = '1~300문항을 선택해 주세요.';
      return;
    }
    const data = new FormData(save);
    data.set('items', JSON.stringify(items));
    data.set('subject', subject.value);
    lock(true);
    status.textContent = '숙제를 배정하고 있습니다.';
    try {
      const response = await fetch('/homework', { method: 'POST', body: data });
      if (!response.ok || !new URL(response.url).searchParams.has('saved'))
        throw Error(await errorMessage(response));
      location.assign(response.url);
    } catch (e) {
      status.textContent = e.message;
      lock(false);
    }
  };
})();
