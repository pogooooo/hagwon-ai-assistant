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

  body[data-page] select.control-select-source {
    position: absolute;
    width: 1px !important;
    height: 1px !important;
    min-width: 0 !important;
    min-height: 0 !important;
    padding: 0 !important;
    border: 0 !important;
    margin: 0;
    overflow: hidden;
    clip-path: inset(50%);
    opacity: 0;
    pointer-events: none;
  }
  .control-select {
    min-width: 0;
    width: 100%;
  }
  .control-combobox {
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
    min-height: 44px;
    gap: 10px;
    padding: 8px 12px;
    border: 1px solid var(--field-border);
    border-radius: var(--field-radius);
    background: var(--field-bg);
    color: var(--field-ink);
    font-size: 15px;
    font-weight: 500;
    cursor: pointer;
  }
  .control-combobox:not([aria-disabled='true']):hover,
  .control-combobox[aria-expanded='true'] {
    border-color: var(--field-focus);
    background: #f9fbf5;
  }
  .control-combobox:focus-visible {
    outline: 2px solid var(--field-focus);
    outline-offset: 2px;
  }
  .control-combobox[aria-disabled='true'] {
    cursor: not-allowed;
    opacity: 0.68;
  }
  .control-combobox[aria-invalid='true'] {
    border-color: #a44531;
  }
  .control-combobox::after {
    content: '';
    flex: none;
    width: 7px;
    height: 7px;
    margin: -4px 3px 0 0;
    border: solid var(--field-focus);
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }
  .control-combobox[aria-expanded='true']::after {
    margin-top: 4px;
    transform: rotate(225deg);
  }
  .control-select-value {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .control-select-error {
    margin: 4px 0 0;
    color: #9e3827;
    font-size: 12px;
  }
  .control-select-options {
    position: fixed;
    z-index: 1000;
    box-sizing: border-box;
    margin: 0;
    padding: 4px;
    overflow-y: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--field-border);
    border-radius: 12px;
    background: var(--field-bg);
    color: var(--field-ink);
    box-shadow: 0 8px 24px #36492a30;
    scrollbar-width: thin;
  }
  .control-select-options[hidden] {
    display: none;
  }
  .control-select-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 42px;
    padding: 7px 10px;
    gap: 8px;
    border-radius: 8px;
    font-size: 14px;
    line-height: 1.5;
    overflow-wrap: anywhere;
    cursor: pointer;
  }
  .control-select-option[aria-selected='true'] {
    font-weight: 700;
    color: #405333;
  }
  .control-select-option[aria-selected='true']::after {
    content: '';
    flex: none;
    width: 9px;
    height: 5px;
    border: solid var(--field-focus);
    border-width: 0 0 2px 2px;
    transform: rotate(-45deg);
  }
  .control-select-option:not([aria-disabled='true']):is([data-highlighted], :hover) {
    background: var(--field-soft);
  }
  .control-select-option[aria-disabled='true'] {
    color: #6f7869;
    cursor: not-allowed;
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
  body[data-page] button {
    appearance: none;
  }
  summary.control-disclosure {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 44px;
    padding: 7px 10px;
    border: 1px solid var(--field-border);
    border-radius: 8px;
    background: #f7f9f2;
    color: var(--field-ink);
    list-style: none;
  }
  summary.control-disclosure::-webkit-details-marker {
    display: none;
  }
  .control-disclosure:hover,
  details[open] > .control-disclosure {
    background: var(--field-soft);
  }
  .control-disclosure-icon,
  .control-inline-icon {
    flex: none;
    width: 7px;
    height: 7px;
    margin-inline-end: 3px;
    border: solid var(--field-focus);
    border-width: 0 2px 2px 0;
  }
  .control-disclosure-icon {
    transform: translateY(-2px) rotate(45deg);
  }
  details[open] > .control-disclosure .control-disclosure-icon {
    transform: translateY(2px) rotate(225deg);
  }
  a.control-inline-link {
    display: inline-flex;
    align-items: center;
    justify-content: space-between;
    vertical-align: middle;
    gap: 9px;
    max-width: 100%;
    padding: 5px 10px;
    min-height: 36px;
    border: 1px solid var(--field-border);
    border-radius: 8px;
    background: #f7f9f2;
    color: #384c2d;
    font-weight: 700;
    text-decoration: none;
  }
  a.control-inline-link:hover {
    border-color: var(--field-focus);
    background: var(--field-soft);
  }
  .control-disclosure-label,
  .control-inline-label {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .control-inline-icon {
    transform: rotate(-45deg);
  }

  a.consultation-shortcut {
    position: fixed;
    z-index: 22;
    inset-inline-end: 24px;
    inset-block-end: 24px;
    border: 1px solid #455831;
    border-radius: 999px;
    background: #425731;
    color: #fff;
    text-decoration: none;
    box-shadow: 0 8px 22px #26371b38;
  }
  a.consultation-shortcut:hover {
    background: #334627;
  }
  .consultation-shortcut-content {
    display: flex;
    align-items: center;
    min-height: 52px;
    gap: 9px;
    padding: 0 16px;
    font-size: 14px;
    font-weight: 700;
  }
  .consultation-shortcut-content .service-icon {
    width: 23px;
    height: 23px;
    color: #fff;
    background: none;
  }
  .consultation-shortcut-content svg {
    width: 23px;
    height: 23px;
  }
  @media (max-width: 780px) {
    a.consultation-shortcut {
      inset-inline-end: max(14px, env(safe-area-inset-right));
      inset-block-end: calc(72px + env(safe-area-inset-bottom));
    }
    .consultation-shortcut-content {
      width: 52px;
      justify-content: center;
      padding: 0;
    }
    .consultation-shortcut-content > span:not(.service-icon) {
      display: none;
    }
    body:has(:is(input:not([type]), input[type='text'], input[type='search'], textarea):focus)
      .consultation-shortcut {
      display: none;
    }
    a.control-inline-link {
      min-height: 44px;
    }
  }
  @media print {
    .consultation-shortcut {
      display: none;
    }
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
