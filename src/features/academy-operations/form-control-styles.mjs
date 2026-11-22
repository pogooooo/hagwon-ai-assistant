import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createGlobalStyle, ServerStyleSheet } from 'styled-components';

const FormControls = createGlobalStyle`
  :root {
    --field-bg: #fff;
    --field-border: #c9d2bf;
    --field-hover: #909e80;
    --field-focus: #647a43;
    --field-ink: #273121;
    --field-soft: #edf2e2;
    --field-radius: 10px;
  }

  body[data-page]
    input:not([type='checkbox'], [type='radio'], [type='file'], [type='hidden'], [type='range'], [type='button'], [type='submit'], [type='image'], [type='reset']),
  body[data-page] :where(select, textarea) {
    border-color: var(--field-border);
    border-radius: var(--field-radius);
    background-color: var(--field-bg);
    color: var(--field-ink);
    font-family: inherit;
  }
  body[data-page] :where(input, select, textarea):not(:disabled):hover {
    border-color: var(--field-hover);
  }
  body[data-page] :is(input, select, textarea):focus-visible,
  body[data-page] :where(button, summary, a[href]):focus-visible {
    outline: 2px solid var(--field-focus);
    outline-offset: 2px;
  }
  body[data-page] :where(input, select, textarea)[aria-invalid='true'] {
    border-color: #a44531;
  }
  body[data-page] :where(input, select, textarea, button):disabled {
    cursor: not-allowed;
    opacity: 0.68;
  }

  body[data-page] select:where(:not([multiple], [size])) {
    appearance: none;
    padding-inline-end: 32px;
    background-image: linear-gradient(45deg, transparent 50%, #566849 50%),
      linear-gradient(135deg, #566849 50%, transparent 50%);
    background-position: right 16px center, right 11px center;
    background-repeat: no-repeat;
    background-size: 5px 5px;
    cursor: pointer;
  }

  @supports (appearance: base-select) and selector(::picker(select)) {
    body[data-page] select:where(:not([multiple], [size])),
    body[data-page] select:where(:not([multiple], [size]))::picker(select) {
      appearance: base-select;
    }
    body[data-page] select:where(:not([multiple], [size])) {
      align-items: center;
      padding-inline-end: 12px;
      background-image: none;
    }
    body[data-page] select::picker-icon {
      color: var(--field-focus);
      margin-inline-start: auto;
    }
    body[data-page] select::picker(select) {
      max-height: min(22rem, 65svh);
      margin-block: 4px;
      padding: 4px;
      border: 1px solid var(--field-border);
      border-radius: 12px;
      background: var(--field-bg);
      box-shadow: 0 8px 22px #36492a25;
    }
    body[data-page] select option {
      min-height: 38px;
      padding: 7px 10px;
      border-radius: 8px;
      color: var(--field-ink);
    }
    body[data-page] select option:is(:checked, :hover, :focus-visible) {
      background: var(--field-soft);
    }
  }

  body[data-page] input:is([type='checkbox'], [type='radio']) {
    appearance: none;
    display: inline-grid;
    place-content: center;
    flex: none;
    width: 18px;
    height: 18px;
    box-sizing: border-box;
    margin: 0;
    border: 1px solid var(--field-hover);
    background: var(--field-bg);
    cursor: pointer;
  }
  body[data-page] input[type='checkbox'] {
    border-radius: 5px;
  }
  body[data-page] input[type='radio'] {
    border-radius: 50%;
  }
  body[data-page] input:is([type='checkbox'], [type='radio']):checked {
    border-color: var(--field-focus);
    background: var(--field-focus);
  }
  body[data-page] input[type='radio']:checked::before {
    content: '';
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: #fff;
  }
  body[data-page] input[type='checkbox']:checked::before {
    content: '';
    width: 9px;
    height: 5px;
    box-sizing: border-box;
    border: solid #fff;
    border-width: 0 0 2px 2px;
    transform: translateY(-1px) rotate(-45deg);
  }
  body[data-page] input[type='checkbox']:indeterminate::before {
    content: '';
    width: 8px;
    height: 2px;
    background: var(--field-focus);
  }
  body[data-page] input[type='file'] {
    border: 1px dashed var(--field-hover);
    border-radius: var(--field-radius);
    background: var(--field-bg);
    color: var(--field-ink);
  }
  body[data-page] input[type='file']::file-selector-button {
    margin-inline-end: 12px;
    padding: 7px 11px;
    border: 1px solid var(--field-border);
    border-radius: 8px;
    background: var(--field-soft);
    color: var(--field-ink);
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }
  body[data-page] input[type='range'],
  body[data-page] progress {
    accent-color: var(--field-focus);
  }
  body[data-page] input::-webkit-calendar-picker-indicator {
    opacity: 0.66;
    cursor: pointer;
  }
  .workspace a:where(:not([class])) {
    text-decoration: none;
  }

  @media (forced-colors: active) {
    body[data-page] select:where(:not([multiple], [size])),
    body[data-page] input:is([type='checkbox'], [type='radio']) {
      appearance: auto;
      background-image: none;
    }
  }
`;

// Build text for the existing stylesheet so the strict same-origin CSP stays intact.
export function renderFormControlStyles() {
  const sheet = new ServerStyleSheet();
  try {
    renderToStaticMarkup(sheet.collectStyles(createElement(FormControls)));
    return sheet
      .getStyleElement()
      .map(({ props }) => props.dangerouslySetInnerHTML.__html)
      .join('\n');
  } finally {
    sheet.seal();
  }
}
