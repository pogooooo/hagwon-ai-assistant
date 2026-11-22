const selectMenu = document.createElement('div');
selectMenu.id = 'ondap-select-options';
selectMenu.className = 'control-select-options';
selectMenu.setAttribute('role', 'listbox');
selectMenu.hidden = true;
const hasTopLayer = typeof selectMenu.showPopover === 'function';
if (hasTopLayer) selectMenu.setAttribute('popover', 'manual');
document.body.append(selectMenu);

let current;

function placeSelectMenu() {
  if (!current) return;
  const rect = current.control.getBoundingClientRect();
  const width = Math.min(Math.max(rect.width, 150), innerWidth - 16);
  const below = innerHeight - rect.bottom - 12;
  const above = rect.top - 12;
  const flip = below < 180 && above > below;
  selectMenu.style.width = width + 'px';
  selectMenu.style.left =
    Math.min(Math.max(8, rect.left), innerWidth - width - 8) + 'px';
  selectMenu.style.maxHeight =
    Math.max(0, Math.min(320, flip ? above : below)) + 'px';
  selectMenu.style.top = flip ? 'auto' : rect.bottom + 5 + 'px';
  selectMenu.style.bottom = flip ? innerHeight - rect.top + 5 + 'px' : 'auto';
}

function closeSelectMenu() {
  if (!current) return;
  current.control.setAttribute('aria-expanded', 'false');
  current.control.removeAttribute('aria-activedescendant');
  if (hasTopLayer && selectMenu.matches(':popover-open'))
    selectMenu.hidePopover();
  selectMenu.hidden = true;
  current = undefined;
}

function highlightOption(index) {
  if (!current || index < 0 || !current.items[index]?.enabled) return;
  current.items[current.index]?.row.removeAttribute('data-highlighted');
  current.index = index;
  const { row } = current.items[index];
  row.setAttribute('data-highlighted', '');
  current.control.setAttribute('aria-activedescendant', row.id);
  row.scrollIntoView({ block: 'nearest' });
}

function openSelectMenu(entry, preferLast = false) {
  if (entry.select.matches(':disabled')) return;
  closeSelectMenu();
  const choices = [...entry.select.options].filter(
    (option) => !option.hidden && !option.parentElement?.hidden,
  );
  if (!choices.length) return;
  const items = choices.map((option, index) => {
    const row = document.createElement('div');
    const enabled = !option.disabled && !option.closest('optgroup:disabled');
    row.id = selectMenu.id + '-' + index;
    row.className = 'control-select-option';
    row.dataset.index = String(index);
    row.textContent = option.label;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(option.selected));
    if (!enabled) row.setAttribute('aria-disabled', 'true');
    return { option, row, enabled };
  });
  current = { ...entry, items, index: -1, typed: '', typedAt: 0 };
  selectMenu.replaceChildren(...items.map(({ row }) => row));
  selectMenu.setAttribute('aria-label', entry.name);
  entry.control.setAttribute('aria-expanded', 'true');
  selectMenu.hidden = false;
  if (hasTopLayer) selectMenu.showPopover();
  placeSelectMenu();
  const selected = items.findIndex(
    ({ option, enabled }) => enabled && option.selected,
  );
  highlightOption(
    selected >= 0
      ? selected
      : preferLast
        ? items.findLastIndex(({ enabled }) => enabled)
        : items.findIndex(({ enabled }) => enabled),
  );
}

function chooseOption(index) {
  const item = current?.items[index];
  if (!item?.enabled) return;
  const { select, control, sync } = current;
  const changed = select.selectedIndex !== item.option.index;
  closeSelectMenu();
  select.selectedIndex = item.option.index;
  sync();
  control.focus({ preventScroll: true });
  if (changed) {
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

function moveOption(direction) {
  const { items, index } = current;
  for (
    let next = index + direction;
    next >= 0 && next < items.length;
    next += direction
  ) {
    if (items[next].enabled) {
      highlightOption(next);
      return;
    }
  }
}

function handleSelectKey(event, entry) {
  if (entry.select.matches(':disabled')) return;
  const open = current?.control === entry.control;
  const { key } = event;
  if (key === 'Tab') {
    closeSelectMenu();
    return;
  }
  if (key === 'Escape') {
    if (open) {
      event.preventDefault();
      event.stopPropagation();
      closeSelectMenu();
    }
    return;
  }
  if (key === 'Enter' || key === ' ') {
    event.preventDefault();
    if (open) chooseOption(current.index);
    else openSelectMenu(entry);
    return;
  }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
    event.preventDefault();
    if (!open) openSelectMenu(entry, key === 'ArrowUp');
    if (!current) return;
    if (key === 'Home')
      highlightOption(current.items.findIndex(({ enabled }) => enabled));
    if (key === 'End')
      highlightOption(current.items.findLastIndex(({ enabled }) => enabled));
    if (open && key === 'ArrowDown') moveOption(1);
    if (open && key === 'ArrowUp') moveOption(-1);
    return;
  }
  if (key.length !== 1 || event.ctrlKey || event.altKey || event.metaKey)
    return;
  event.preventDefault();
  if (!open) openSelectMenu(entry);
  if (!current) return;
  const now = Date.now();
  const text = key.toLocaleLowerCase();
  const prefix = now - current.typedAt > 600 ? text : current.typed + text;
  current.typed = prefix;
  current.typedAt = now;
  highlightOption(
    current.items.findIndex(
      ({ option, enabled }) =>
        enabled && option.label.toLocaleLowerCase().startsWith(prefix),
    ),
  );
}

function selectName(select) {
  return (
    select.getAttribute('aria-label') ||
    [...(select.labels ?? [])]
      .map((label) => {
        const copy = label.cloneNode(true);
        copy
          .querySelectorAll('select, input, .control-select')
          .forEach((node) => node.remove());
        return copy.textContent.trim();
      })
      .join(' ')
      .trim() ||
    '항목 선택'
  );
}

function enhanceSelect(select, index) {
  const root = document.createElement('div');
  root.className = 'control-select';
  const control = document.createElement('div');
  control.className = 'control-combobox';
  const name = selectName(select);
  control.setAttribute('role', 'combobox');
  control.setAttribute('aria-label', name);
  if (select.hasAttribute('aria-labelledby'))
    control.setAttribute(
      'aria-labelledby',
      select.getAttribute('aria-labelledby'),
    );
  control.setAttribute('aria-expanded', 'false');
  control.setAttribute('aria-controls', selectMenu.id);
  const value = document.createElement('span');
  value.className = 'control-select-value';
  control.append(value);
  const error = document.createElement('p');
  error.id = 'ondap-select-error-' + index;
  error.className = 'control-select-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  root.append(control, error);
  select.after(root);
  select.classList.add('control-select-source');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');
  const originalDescription = select.getAttribute('aria-describedby') ?? '';
  const clearError = () => {
    error.hidden = true;
    control.removeAttribute('aria-invalid');
    if (originalDescription)
      control.setAttribute('aria-describedby', originalDescription);
    else control.removeAttribute('aria-describedby');
  };
  const sync = () => {
    const disabled = select.matches(':disabled');
    root.hidden = select.hidden;
    value.textContent = select.selectedOptions[0]?.label ?? '선택';
    control.tabIndex = disabled ? -1 : 0;
    control.setAttribute('aria-disabled', String(disabled));
    control.setAttribute('aria-required', String(select.required));
    if (select.validity.valid) clearError();
  };
  const entry = { select, control, name, sync };
  control.addEventListener('pointerdown', (event) => {
    if (event.pointerType === 'mouse') event.preventDefault();
  });
  control.addEventListener('click', (event) => {
    event.preventDefault();
    if (select.matches(':disabled')) return;
    control.focus({ preventScroll: true });
    if (current?.control === control) closeSelectMenu();
    else openSelectMenu(entry);
  });
  control.addEventListener('keydown', (event) => handleSelectKey(event, entry));
  select.addEventListener('input', sync);
  select.addEventListener('change', sync);
  select.addEventListener('focus', () =>
    control.focus({ preventScroll: true }),
  );
  select.addEventListener('invalid', (event) => {
    event.preventDefault();
    error.textContent = select.validationMessage;
    error.hidden = false;
    control.setAttribute('aria-invalid', 'true');
    control.setAttribute(
      'aria-describedby',
      [originalDescription, error.id].filter(Boolean).join(' '),
    );
    if (!document.querySelector(':focus[aria-invalid="true"]')) control.focus();
  });
  select.form?.addEventListener('reset', () => queueMicrotask(sync));
  window.addEventListener('pageshow', sync);
  new MutationObserver(() => {
    sync();
    if (current?.control === control) closeSelectMenu();
  }).observe(select, {
    attributes: true,
    attributeFilter: [
      'disabled',
      'hidden',
      'required',
      'label',
      'value',
      'selected',
    ],
    subtree: true,
    childList: true,
    characterData: true,
  });
  sync();
}

selectMenu.addEventListener('click', (event) => {
  const row = event.target.closest('[data-index]');
  if (row) chooseOption(Number(row.dataset.index));
});
document.addEventListener('pointerdown', (event) => {
  if (
    current &&
    !current.control.contains(event.target) &&
    !selectMenu.contains(event.target)
  )
    closeSelectMenu();
});
window.addEventListener('resize', placeSelectMenu);
window.addEventListener('scroll', placeSelectMenu, true);

document
  .querySelectorAll('select:not([multiple], [size])')
  .forEach(enhanceSelect);
