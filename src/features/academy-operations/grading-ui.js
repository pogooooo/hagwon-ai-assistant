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
if (picker) {
  const previews = document.querySelector('[data-previews]');
  let urls = [];
  function clear() {
    for (const url of urls) URL.revokeObjectURL(url);
    urls = [];
    previews.replaceChildren();
  }
  picker.addEventListener('change', () => {
    clear();
    const files = Array.from(picker.files);
    const pageCount = picker.form.elements.namedItem('pages');
    if (files.length && files.every((file) => file.type.startsWith('image/')))
      pageCount.value = String(files.length);
    for (const [i, file] of files.entries()) {
      const figure = document.createElement('figure');
      if (['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        const image = document.createElement('img');
        image.src = URL.createObjectURL(file);
        urls.push(image.src);
        image.alt = '';
        figure.append(image);
      }
      const label = document.createElement('figcaption');
      label.textContent = i + 1 + '. ' + file.name;
      figure.append(label);
      previews.append(figure);
    }
  });
  window.addEventListener('pagehide', clear);
}
