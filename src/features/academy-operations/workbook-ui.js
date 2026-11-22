(() => {
  const section = document.querySelector('#homework-create');
  if (!section) return;
  const photo = section.querySelector('#workbook-photo'),
    save = section.querySelector('#workbook-save'),
    first = section.querySelector('#workbook-first'),
    status = section.querySelector('#workbook-status'),
    rows = section.querySelector('#workbook-rows');
  const catalog = JSON.parse(section.dataset.items),
    tags = JSON.parse(section.dataset.tags);
  // 사진 채점의 과제 등록 탭에서는 /grading으로 보내고 문항마다 정답을 받는다.
  const base = section.dataset.base || '/homework',
    done = section.dataset.done || 'detail',
    requireAnswer = section.dataset.requireAnswer === '1';
  const states = new Map();
  async function request(action, data) {
    data.set('_academyAccount', document.body.dataset.account);
    const res = await fetch(base + '?' + action + '=1', {
      method: 'POST',
      body: data,
    });
    if (
      !res.ok ||
      !res.headers.get('content-type')?.includes('application/json')
    ) {
      const doc = new DOMParser().parseFromString(
        await res.text(),
        'text/html',
      );
      throw Error(
        doc.querySelector('[role="alert"]')?.textContent ||
          '분석 요청을 확인해 주세요.',
      );
    }
    return res.json();
  }
  function add(item) {
    const row = section
      .querySelector('#workbook-row')
      .content.firstElementChild.cloneNode(true);
    const find = (s) => row.querySelector(s);
    const selected = new Set(item.tagIds || []);
    states.set(row, selected);
    find('[data-page]').value = item.page || '';
    find('[data-number]').value = item.number || '';
    find('[data-select]').checked = !!item.selected;
    const answer = find('[data-answer]');
    if (answer) {
      const choice = find('[data-is-choice]');
      const options = (item.answer || '').split('|').map((s) => s.trim());
      const legacyChoice = options.every((s) => /^[①-⑨]$|^[1-9]번$/u.test(s));
      choice.checked =
        item.is_choice == null
          ? !item.answer || legacyChoice
          : !!item.is_choice;
      answer.value =
        choice.checked && legacyChoice
          ? options
              .map((s) => String('①②③④⑤⑥⑦⑧⑨'.indexOf(s) + 1 || parseInt(s, 10)))
              .join(' | ')
          : item.answer || '';
      const updateAnswer = () => {
        find('[data-answer-label]').textContent = choice.checked
          ? '정답 보기 번호'
          : '주관식 정답';
        answer.placeholder = choice.checked ? '예: 3' : '예: 5/6 L';
        answer.inputMode = choice.checked ? 'numeric' : 'text';
      };
      choice.onchange = updateAnswer;
      updateAnswer();
    }
    const area = find('[data-area]'),
      minor = find('[data-minor]'),
      chosen = find('[data-chosen]');
    area.add(new Option('대분류 선택', ''));
    for (const name of new Set(tags.map((t) => t.area)))
      area.add(new Option(name, name));
    // 소분류 추천이 없어도 대분류 추천(item.area)이 있으면 대분류를 미리 골라 둔다.
    area.value =
      tags.find((t) => selected.has(t.tagId))?.area || item.area || '';
    function update() {
      chosen.textContent =
        '선택 유형 · ' +
        (tags
          .filter((t) => selected.has(t.tagId))
          .map((t) => t.area + ' / ' + t.name)
          .join(', ') || '미지정');
      minor.replaceChildren();
      for (const t of tags.filter((t) => t.area === area.value)) {
        const label = document.createElement('label'),
          input = document.createElement('input');
        label.className = 'check-label';
        input.type = 'checkbox';
        input.checked = selected.has(t.tagId);
        input.onchange = () => {
          if (input.checked) selected.add(t.tagId);
          else selected.delete(t.tagId);
          update();
        };
        label.append(input, document.createTextNode(t.name));
        minor.append(label);
      }
    }
    area.onchange = update;
    update();
    const reading = find('[data-reading]');
    if (item.sourceId) {
      reading.hidden = false;
      reading.textContent = item.review
        ? '판독 보류 · ' + item.review.reason
        : item.text || '유형을 확인해 주세요.';
      if (item.review) {
        find('[data-review]').hidden = false;
        find('[data-transcript]').value = item.review.candidates[0] || '';
        find('[data-reclassify]').onclick = async () => {
          const data = new FormData();
          data.set('subject', photo.elements.subject.value);
          data.set('sourceId', item.sourceId);
          data.set('text', find('[data-transcript]').value);
          first.inert = true;
          status.textContent = '원문을 다시 분류하고 있습니다.';
          try {
            const reviewed = await request('review', data);
            selected.clear();
            for (const id of reviewed.tagIds) selected.add(id);
            area.value =
              tags.find((t) => selected.has(t.tagId))?.area ||
              reviewed.area ||
              '';
            update();
            reading.textContent = reviewed.text;
            find('[data-review]').hidden = true;
            find('[data-select]').checked = true;
            status.textContent = '재분류를 마쳤습니다.';
          } catch (e) {
            status.textContent = e.message;
          } finally {
            first.inert = false;
          }
        };
      }
    }
    find('[data-remove]').onclick = () => {
      states.delete(row);
      row.remove();
    };
    rows.append(row);
    return row;
  }
  for (const item of catalog) add(item);
  section.querySelector('#workbook-add').onclick = () =>
    add({ selected: true }).querySelector('[data-page]').focus();
  photo.onsubmit = async (event) => {
    event.preventDefault();
    const data = new FormData(photo);
    first.inert = true;
    status.textContent = '사진 속 문항과 유형을 분석하고 있습니다.';
    try {
      const items = await request('analyze', data);
      for (const item of items) {
        const existing = [...states.keys()].find(
          (row) =>
            item.page &&
            Number(row.querySelector('[data-page]').value) === item.page &&
            row.querySelector('[data-number]').value === item.number,
        );
        if (existing) {
          existing.querySelector('[data-select]').checked = true;
          continue;
        }
        add({ ...item, selected: !item.review });
      }
      photo.elements.photo.value = '';
      status.textContent =
        items.length + '문항을 확인했습니다. 쪽수가 비어 있으면 입력해 주세요.';
    } catch (e) {
      status.textContent = e.message;
    } finally {
      first.inert = false;
    }
  };
  section.querySelector('#workbook-next').onclick = () => {
    const items = [],
      seen = new Set();
    for (const [row, tags] of states) {
      if (!row.querySelector('[data-select]').checked) continue;
      const page = Number(row.querySelector('[data-page]').value),
        number = row.querySelector('[data-number]').value.trim(),
        answer = row.querySelector('[data-answer]')?.value.trim() ?? '';
      if (!Number.isInteger(page) || page < 1 || page > 100000 || !number) {
        status.textContent = '선택한 문항의 쪽수와 번호를 입력해 주세요.';
        return;
      }
      if (requireAnswer && !answer) {
        status.textContent =
          page + '쪽 ' + number + '번의 정답을 입력해 주세요.';
        return;
      }
      const isChoice = !!row.querySelector('[data-is-choice]')?.checked;
      if (
        isChoice &&
        !answer.split('|').every((s) => /^[1-9]$/.test(s.trim()))
      ) {
        status.textContent =
          page +
          '쪽 ' +
          number +
          '번의 정답 보기 번호를 1~9 사이 숫자로 입력해 주세요.';
        row.querySelector('[data-answer]').focus();
        return;
      }
      const key = JSON.stringify([page, number]);
      if (seen.has(key)) {
        status.textContent = '같은 쪽수와 번호의 문항이 중복되었습니다.';
        return;
      }
      seen.add(key);
      const master = catalog.find(
        (q) => q.page === page && q.number === number,
      );
      items.push({
        page,
        number,
        tagIds: [...tags],
        version: master?.version ?? null,
        ...(requireAnswer ? { answer, isChoice } : {}),
      });
    }
    if (!items.length || items.length > 300) {
      status.textContent = '1~300문항을 선택해 주세요.';
      return;
    }
    save.elements.items.value = JSON.stringify(items);
    section.querySelector('#workbook-summary').textContent =
      items.length +
      '문항 · ' +
      items.map((q) => q.page + '쪽 ' + q.number + '번').join(', ');
    first.hidden = true;
    save.hidden = false;
    save.elements.title.focus();
    status.textContent = '';
  };
  section.querySelector('#workbook-back').onclick = () => {
    save.hidden = true;
    first.hidden = false;
    status.textContent = '';
  };
  save.elements.targetKind.onchange = () => {
    const individual = save.elements.targetKind.value === 'student';
    for (const [selector, hide] of [
      ['#class-targets', individual],
      ['#student-targets', !individual],
    ]) {
      const group = save.querySelector(selector);
      group.hidden = group.disabled = hide;
    }
  };
  save.onsubmit = async (event) => {
    event.preventDefault();
    if (!save.querySelector('fieldset:not([disabled]) input:checked')) {
      status.textContent = '배정 대상을 선택해 주세요.';
      return;
    }
    const data = new FormData(save);
    save.inert = true;
    try {
      const res = await fetch(base, { method: 'POST', body: data });
      if (!res.ok || !new URL(res.url).searchParams.has(done)) {
        const doc = new DOMParser().parseFromString(
          await res.text(),
          'text/html',
        );
        throw Error(
          doc.querySelector('[role="alert"]')?.textContent ||
            '배정할 수 없습니다.',
        );
      }
      location.assign(res.url);
    } catch (e) {
      status.textContent = e.message;
      save.inert = false;
    }
  };
})();
