function renderControlParts(element, labelClass, iconClass) {
  const label = document.createElement('div');
  label.className = labelClass;
  label.append(...element.childNodes);
  const icon = document.createElement('div');
  icon.className = iconClass;
  icon.setAttribute('aria-hidden', 'true');
  element.append(label, icon);
}

for (const summary of document.querySelectorAll(
  '.workspace details > summary',
)) {
  if (summary.querySelector('a, button, input, select, textarea')) continue;
  summary.classList.add('control-disclosure');
  renderControlParts(
    summary,
    'control-disclosure-label',
    'control-disclosure-icon',
  );
}

for (const link of document.querySelectorAll(
  '.workspace a[href]:not([class])',
)) {
  if (
    link.childElementCount ||
    !link.textContent.trim() ||
    link.closest('nav, .view-tabs, .page-tabs, .record-list')
  )
    continue;
  link.classList.add('control-inline-link');
  renderControlParts(link, 'control-inline-label', 'control-inline-icon');
}
