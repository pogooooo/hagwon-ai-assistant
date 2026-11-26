const work = document.querySelector('[data-review]');
if (work) {
  const items = [...work.querySelectorAll('[data-review-item]')];
  const buttons = [...work.querySelectorAll('[data-select-item]')];
  const pages = [...work.querySelectorAll('[data-page]')];
  const selector = work.querySelector('[data-page-select]');
  function showPage(number) {
    selector.value = number;
    pages.forEach((page) => {
      page.hidden = page.dataset.page !== number;
    });
  }
  function selectItem(index) {
    items.forEach((item, i) => {
      item.hidden = i !== index;
    });
    buttons.forEach((button, i) =>
      button.setAttribute('aria-pressed', String(i === index)),
    );
    showPage(items[index].dataset.itemPage);
  }
  work.querySelectorAll('[data-enhance]').forEach((el) => {
    el.hidden = false;
  });
  buttons.forEach((button, index) =>
    button.addEventListener('click', () => selectItem(index)),
  );
  selector.addEventListener('change', () => showPage(selector.value));
  for (const [action, method] of [
    ['turn', 'rotate'],
    ['zoom', 'zoom'],
    ['fit', 'reset'],
  ]) {
    work
      .querySelector('[data-' + action + ']')
      .addEventListener('click', () => {
        const page = pages.find((p) => !p.hidden);
        if (method === 'rotate')
          page.dataset.rotation = String(
            ((Number(page.dataset.rotation) || 0) + 90) % 360,
          );
        if (method === 'zoom') page.classList.toggle('is-zoomed');
        if (method === 'reset') {
          page.dataset.rotation = '0';
          page.classList.remove('is-zoomed');
        }
      });
  }
  const review = work.querySelector('.grade-decisions form');
  review.addEventListener('input', () => {
    work.querySelector('.grade-footer button').disabled = true;
  });
  if (items.length) selectItem(Number(work.dataset.initial));
}
const picker = document.querySelector('.grade-picker input');
if (picker && typeof DataTransfer === 'function') {
  const previews = picker.form.querySelector('[data-previews]');
  const status = picker.form.querySelector('[data-file-status]');
  const submit = picker.form.querySelector('[data-grade-submit]');
  picker.form.classList.add('photos-enhanced');
  const limit = Number(picker.dataset.maxFiles);
  let entries = [];
  let busy = false;
  function update(message = '') {
    const transfer = new DataTransfer();
    previews.replaceChildren();
    for (const [i, entry] of entries.entries()) {
      transfer.items.add(entry.file);
      const figure = document.createElement('figure');
      if (entry.url) {
        const image = document.createElement('img');
        image.src = entry.url;
        image.alt = '';
        figure.append(image);
      }
      const label = document.createElement('figcaption');
      label.textContent = i + 1 + '. ' + entry.file.name;
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'secondary';
      remove.textContent = '빼기';
      remove.setAttribute('aria-label', label.textContent + ' 빼기');
      remove.onclick = () => {
        if (busy) return;
        if (entry.url) URL.revokeObjectURL(entry.url);
        entries.splice(i, 1);
        update();
      };
      figure.append(label, remove);
      previews.append(figure);
    }
    picker.files = transfer.files;
    const imagesOnly = entries.every(({ file }) =>
      file.type.startsWith('image/'),
    );
    submit.disabled = busy || !entries.length;
    submit.textContent = entries.length
      ? (imagesOnly
          ? '사진 ' + entries.length + '장'
          : '파일 ' + entries.length + '개') + ' 제출'
      : '숙제 제출';
    status.textContent = [
      message,
      entries.length
        ? '첨부 ' + entries.length + '개. 파일을 더 추가할 수 있습니다.'
        : '',
    ]
      .filter(Boolean)
      .join(' ');
  }
  async function prepare(file) {
    if (
      !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
      typeof createImageBitmap !== 'function'
    )
      return file;
    const image = await createImageBitmap(file);
    try {
      const scale = Math.min(
        1,
        Math.sqrt(
          Number(picker.dataset.maxPixels) / (image.width * image.height),
        ),
      );
      if (scale === 1 && file.size <= Number(picker.dataset.maxBytes) / limit)
        return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(image.width * scale));
      canvas.height = Math.max(1, Math.floor(image.height * scale));
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.88),
      );
      if (!blob) throw Error();
      return new File([blob], file.name.replace(/\.[^.]*$/, '') + '.jpg', {
        type: 'image/jpeg',
        lastModified: file.lastModified,
      });
    } finally {
      image.close();
    }
  }
  picker.addEventListener('change', async () => {
    const added = Array.from(picker.files);
    const next = [];
    busy = true;
    picker.disabled = submit.disabled = true;
    let message = '';
    try {
      for (const file of added) {
        const key = JSON.stringify([file.name, file.size, file.lastModified]);
        if ([...entries, ...next].some((e) => e.key === key)) continue;
        if (entries.length + next.length >= limit)
          throw Error(
            '한 번에 최대 ' + limit + '개 파일까지 첨부할 수 있습니다.',
          );
        const prepared = await prepare(file);
        next.push({ key, file: prepared, url: null });
      }
      if (
        [...entries, ...next].reduce((n, e) => n + e.file.size, 0) >
        Number(picker.dataset.maxBytes)
      )
        throw Error('첨부 용량을 초과했습니다. 파일을 나누어 제출해 주세요.');
      for (const e of next)
        if (e.file.type.startsWith('image/'))
          e.url = URL.createObjectURL(e.file);
      entries.push(...next);
    } catch (error) {
      message = error.message || '파일을 읽을 수 없습니다. 다시 선택해 주세요.';
    } finally {
      busy = false;
      picker.disabled = false;
      update(message);
    }
  });
  picker.form.addEventListener('submit', (e) => {
    if (busy) e.preventDefault();
  });
  update();
}
