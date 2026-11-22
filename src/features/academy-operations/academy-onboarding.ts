import { randomUUID } from 'node:crypto';
import type { OperationsDatabase } from './database.ts';
import { hashPassword } from './directory.ts';
import {
  academyRegistration,
  neisText,
  type createNeisClient,
} from './neis.ts';
import {
  escapeHtml as h,
  field,
  one,
  OperationError,
  required,
  transaction,
} from './shared.ts';

export const onboardingPath = '/academy-registration';

const regions = [
  ['B10', '서울'],
  ['C10', '부산'],
  ['D10', '대구'],
  ['E10', '인천'],
  ['F10', '광주'],
  ['G10', '대전'],
  ['H10', '울산'],
  ['I10', '세종'],
  ['J10', '경기'],
  ['K10', '강원'],
  ['M10', '충북'],
  ['N10', '충남'],
  ['P10', '전북'],
  ['Q10', '전남'],
  ['R10', '경북'],
  ['S10', '경남'],
  ['T10', '제주'],
] as const;
const timeout = 30 * 60 * 1000;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const queryField = { name: '', office: '', district: '' };
type SearchQuery = typeof queryField;
type PublicAcademy = {
  officialId: string;
  office: string;
  district: string;
  name: string;
  address: string;
  phone: string;
  course: string;
  category: string;
  status: string;
};
interface SearchResult {
  query: SearchQuery;
  complete: boolean;
  fetchedAt: string;
  academies: PublicAcademy[];
}
interface SetupScope {
  key: string;
  owner?: { id: string; name: string };
}
export interface SavedAcademyProfile {
  address: string;
  phone: string;
  course: string;
  category: string;
  district: string;
  source: string | null;
}

export function setupAcademyOnboarding(db: OperationsDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS op_academy_setup_searches (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, result TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS op_academy_setup_usage (
      window INTEGER NOT NULL, bucket TEXT NOT NULL, hits INTEGER NOT NULL,
      PRIMARY KEY (window,bucket)
    );
    CREATE TABLE IF NOT EXISTS op_academy_profiles (
      academy_id TEXT PRIMARY KEY REFERENCES academies(id) ON DELETE CASCADE,
      creator_id TEXT NOT NULL REFERENCES accounts(id),
      submission_scope TEXT NOT NULL, request_id TEXT NOT NULL,
      address TEXT NOT NULL, phone TEXT NOT NULL, course TEXT NOT NULL, category TEXT NOT NULL, district TEXT NOT NULL,
      source TEXT, official_key TEXT,
      UNIQUE(submission_scope, request_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS op_academy_creator_official
      ON op_academy_profiles(creator_id, official_key) WHERE official_key IS NOT NULL;
  `);
}

export function savedAcademyProfile(db: OperationsDatabase, academyId: string) {
  return one<SavedAcademyProfile>(
    db,
    'SELECT address,phone,course,category,district,source FROM op_academy_profiles WHERE academy_id=?',
    academyId,
  );
}

function takeLimit(
  db: OperationsDatabase,
  scope: SetupScope,
  action: 'lookup' | 'register',
) {
  const hour = Math.floor(Date.now() / 3_600_000);
  const lookup = action === 'lookup';
  const limits = [
    [action + ':all', lookup ? 180 : 40],
    [action + ':' + scope.key, lookup ? 15 : 5],
  ] as const;
  db.prepare('DELETE FROM op_academy_setup_usage WHERE window<?').run(hour - 1);
  for (const [bucket, max] of limits)
    if (
      !db
        .prepare(
          `
      INSERT INTO op_academy_setup_usage VALUES(?,?,1)
      ON CONFLICT(window,bucket) DO UPDATE SET hits=hits+1 WHERE hits<?
    `,
        )
        .run(hour, bucket, max).changes
    )
      throw new OperationError(
        '잠시 후 다시 시도해 주세요. 검색이 어려우면 학원 정보를 직접 입력할 수 있습니다.',
        429,
      );
}

function readSearch(db: OperationsDatabase, scope: SetupScope, id: string) {
  if (!uuid.test(id))
    throw new OperationError('검색을 다시 진행해 주세요.', 400);
  const row = one<{ result: string }>(
    db,
    'SELECT result FROM op_academy_setup_searches WHERE id=? AND scope=? AND expires_at>?',
    id,
    scope.key,
    Date.now(),
  );
  if (!row)
    throw new OperationError(
      '검색 결과가 만료되었습니다. 학원 이름을 다시 검색해 주세요.',
      409,
    );
  return JSON.parse(row.result) as SearchResult;
}

export async function searchForAcademy(
  db: OperationsDatabase,
  neis: ReturnType<typeof createNeisClient>,
  scope: SetupScope,
  form: FormData,
  authorize: () => void,
) {
  const query = {
    name: required(form, 'name', '학원 이름', 100),
    office: required(form, 'office', '시·도', 3),
    district: field(form, 'district', 40),
  };
  if (!regions.some(([code]) => code === query.office))
    throw new OperationError('시·도를 선택해 주세요.');
  transaction(db, () => takeLimit(db, scope, 'lookup'));
  const result = await neis.query(
    'acaInsTiInfo',
    {
      ATPT_OFCDC_SC_CODE: query.office,
      ACA_NM: query.name,
      ...(query.district ? { ADMST_ZONE_NM: query.district } : {}),
    },
    { firstPage: true },
  );
  authorize();
  const choices = new Map<string, PublicAcademy>();
  for (const row of result.rows) {
    const officialId = neisText(row, 'ACA_ASNUM');
    const office = neisText(row, 'ATPT_OFCDC_SC_CODE');
    const name = neisText(row, 'ACA_NM');
    if (!officialId || office !== query.office || !name) continue;
    const record = academyRegistration(row);
    const current = choices.get(officialId);
    if (current) {
      const courses = new Set(current.course.split(' · ').filter(Boolean));
      if (record.course || record.subject)
        courses.add(record.course || record.subject);
      current.course = [...courses].join(' · ').slice(0, 160);
    } else {
      choices.set(officialId, {
        officialId,
        office,
        name,
        district: neisText(row, 'ADMST_ZONE_NM'),
        address: record.address,
        phone: neisText(row, 'FA_TELNO'),
        course: (record.course || record.subject).slice(0, 160),
        category: neisText(row, 'ACA_INSTI_SC_NM'),
        status: record.status,
      });
    }
  }
  const payload: SearchResult = {
    query,
    complete: result.complete,
    fetchedAt: result.fetchedAt,
    academies: [...choices.values()],
  };
  const key = randomUUID();
  transaction(db, () => {
    db.prepare('DELETE FROM op_academy_setup_searches WHERE expires_at<=?').run(
      Date.now(),
    );
    db.prepare('INSERT INTO op_academy_setup_searches VALUES(?,?,?,?)').run(
      key,
      scope.key,
      JSON.stringify(payload),
      Date.now() + timeout,
    );
  });
  return key;
}

function selectedAcademy(search: SearchResult, index: string) {
  const choice = /^\d{1,2}$/.test(index)
    ? search.academies[Number(index)]
    : undefined;
  if (!choice)
    throw new OperationError('검색 결과에서 학원을 다시 선택해 주세요.', 400);
  return choice;
}

function inputField(
  name: string,
  label: string,
  value: string,
  maximum: number,
  extra = '',
) {
  return `<label>${label}<input name="${name}" value="${h(value)}" maxlength="${maximum}" ${extra}></label>`;
}

export function renderAcademyOnboarding(
  db: OperationsDatabase,
  scope: SetupScope,
  url: URL,
  form?: FormData,
  error = '',
): string {
  const action = form?.get('action');
  const attempt = (name: string) => {
    const value = form?.get(name);
    return typeof value === 'string' ? value.slice(0, 320) : '';
  };
  const submitted = action === 'register';
  const searchId = submitted
    ? attempt('search')
    : (url.searchParams.get('search') ?? '');
  const position = submitted
    ? attempt('candidate')
    : (url.searchParams.get('candidate') ?? '');
  let saved: SearchResult | undefined;
  let choice: PublicAcademy | undefined;
  if (searchId) {
    try {
      saved = readSearch(db, scope, searchId);
      if (position) choice = selectedAcademy(saved, position);
    } catch (lookupError) {
      if (!(lookupError instanceof OperationError)) throw lookupError;
      error ||= lookupError.message;
    }
  }
  const review =
    !!choice ||
    url.searchParams.get('manual') === '1' ||
    (submitted && !searchId);
  const query =
    action === 'search'
      ? {
          name: attempt('name'),
          office: attempt('office'),
          district: attempt('district'),
        }
      : (saved?.query ?? queryField);
  const back = scope.owner ? '/academies' : '/login';
  const heading = `<div class="workspace-heading"><h1>새 학원 등록</h1><a class="workspace-link" href="${back}">${scope.owner ? '내 학원' : '로그인'}</a></div>`;
  const alert = error ? `<p class="notice" role="alert">${h(error)}</p>` : '';
  const wrap = (body: string) =>
    `<div class="academy-onboarding">${heading}${alert}${body}</div>`;
  if (review) {
    const value = (key: keyof Omit<PublicAcademy, 'officialId'>) =>
      submitted
        ? attempt(key)
        : (choice?.[key] ??
          (key === 'name' || key === 'district' ? query[key] : ''));
    const requestId =
      submitted && uuid.test(attempt('requestId'))
        ? attempt('requestId')
        : randomUUID();
    const account = scope.owner
      ? ''
      : `<fieldset><legend>원장 계정 만들기</legend><div class="academy-setup-fields">
      ${inputField('ownerName', '원장 이름', attempt('ownerName'), 80, 'autocomplete="name" required')}
      ${inputField('username', '로그인 아이디', attempt('username'), 64, 'autocomplete="username" required')}
      <label>비밀번호<input name="password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required><span class="muted">12자 이상 입력해 주세요.</span></label>
      <label>비밀번호 확인<input name="passwordConfirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>
      </div></fieldset>`;
    return wrap(`<section class="panel"><h2>학원 기본 정보 확인</h2>
      ${choice ? `<p class="muted">나이스 교육정보 개방포털 · ${h(choice.name)} · ${h(choice.status)} · ${h(saved?.fetchedAt.slice(0, 10))} 조회</p>` : ''}
      <form method="post" action="${onboardingPath}">
        <input type="hidden" name="action" value="register">
        <input type="hidden" name="requestId" value="${h(requestId)}">
        <input type="hidden" name="entry" value="${scope.owner ? 'existing' : 'first'}">
        ${choice && saved ? `<input type="hidden" name="search" value="${h(searchId)}"><input type="hidden" name="candidate" value="${h(position)}">` : ''}
        <div class="academy-setup-fields">
          ${inputField('name', '학원 이름', value('name'), 100, 'required')}
          ${inputField('address', '주소', value('address'), 240, 'autocomplete="street-address"')}
          ${inputField('district', '시·군·구', value('district'), 40)}
          ${inputField('phone', '학원 전화번호', value('phone'), 40, 'type="tel" autocomplete="tel"')}
          ${inputField('category', '기관 유형', value('category'), 80, 'placeholder="예: 학원, 교습소"')}
          ${inputField('course', '교습과정', value('course'), 160, 'placeholder="예: 중등 수학"')}
        </div>
        ${account}<div class="actions"><button>${scope.owner ? '학원 등록' : '학원 등록하고 시작'}</button><a class="workspace-link" href="${onboardingPath}${saved ? '?search=' + encodeURIComponent(searchId) : ''}">다시 검색</a></div>
      </form></section>`);
  }
  const manual =
    onboardingPath +
    '?manual=1' +
    (saved ? '&amp;search=' + encodeURIComponent(searchId) : '');
  const optionList = regions
    .map(
      ([id, label]) =>
        `<option value="${id}"${query.office === id ? ' selected' : ''}>${label}</option>`,
    )
    .join('');
  const results = saved
    ? `<section class="panel"><h2>검색 결과</h2>
    ${
      saved.academies.length
        ? `<p role="status">${saved.academies.length}개 학원 표시${saved.complete ? '' : ' · 일부 결과입니다. 지역이나 학원명을 좁혀 주세요.'}</p>
    <ul class="academy-setup-results">${saved.academies
      .map(
        (academy, index) =>
          `<li><div><strong>${h(academy.name)}</strong><p>${h(academy.address || academy.district || '등록 주소 없음')}</p>
      <small>${h([academy.category, academy.course, academy.status].filter(Boolean).join(' · '))}</small></div>
      <a class="button-link subtle-link" href="${onboardingPath}?search=${encodeURIComponent(searchId)}&amp;candidate=${index}">이 학원 정보 사용</a></li>`,
      )
      .join('')}</ul>`
        : '<p role="status">일치하는 학원이 없습니다. 등록 명칭으로 다시 검색하거나 정보를 직접 입력할 수 있습니다.</p>'
    }
    </section>`
    : '';
  const searchFields = `<form method="post" action="${onboardingPath}" class="academy-setup-fields">
      <input type="hidden" name="action" value="search">
      ${inputField('name', '학원 이름', query.name, 100, 'placeholder="교육청에 등록된 학원명" required')}
      <label>시·도<select name="office" required><option value="">시·도 선택</option>${optionList}</select></label>
      ${inputField('district', '시·군·구 (선택)', query.district, 40, 'placeholder="예: 아산시"')}
      <div class="actions"><button>학원 검색</button><a class="workspace-link" href="${manual}">직접 입력</a></div>
    </form>`;
  return wrap(
    saved
      ? results +
          `<section class="panel academy-setup-refine"><div class="actions"><a class="workspace-link" href="${manual}">직접 입력</a></div><details><summary>검색 조건 변경</summary>${searchFields}</details></section>`
      : `<section class="panel"><h2>학원 찾기</h2><p>나이스에 등록된 학원명으로 검색해 기본 정보를 불러옵니다.</p>${searchFields}</section>`,
  );
}

export function createAcademyFromOnboarding(
  db: OperationsDatabase,
  scope: SetupScope,
  form: FormData,
) {
  if (field(form, 'entry') !== (scope.owner ? 'existing' : 'first'))
    throw new OperationError(
      '접속 상태가 바뀌었습니다. 등록 화면을 다시 열어 주세요.',
      409,
    );
  const requestId = field(form, 'requestId', 36);
  if (!uuid.test(requestId))
    throw new OperationError('등록 화면을 다시 열어 주세요.');
  if (
    one(
      db,
      'SELECT 1 FROM op_academy_profiles WHERE submission_scope=? AND request_id=?',
      scope.key,
      requestId,
    )
  )
    throw new OperationError(
      '이미 처리된 등록입니다. 내 학원이나 로그인 화면에서 확인해 주세요.',
      409,
    );

  let official: PublicAcademy | undefined;
  let fetchedAt = '';
  const searchId = field(form, 'search', 36);
  const candidate = field(form, 'candidate', 2);
  if (searchId || candidate) {
    const search = readSearch(db, scope, searchId);
    official = selectedAcademy(search, candidate);
    fetchedAt = search.fetchedAt;
  }
  const officialKey = official
    ? official.office + ':' + official.officialId
    : null;
  if (
    scope.owner &&
    officialKey &&
    one(
      db,
      'SELECT 1 FROM op_academy_profiles WHERE creator_id=? AND official_key=?',
      scope.owner.id,
      officialKey,
    )
  )
    throw new OperationError('내 학원에 이미 등록된 교육청 목록입니다.', 409);

  const name = required(form, 'name', '학원 이름', 100);
  const address = field(form, 'address', 240);
  const phone = field(form, 'phone', 40);
  const district = field(form, 'district', 40);
  const course = field(form, 'course', 160);
  const category = field(form, 'category', 80);
  const academyId = 'academy-' + randomUUID();
  const profileId = 'owner-' + randomUUID();
  let username = profileId;
  let ownerName = scope.owner?.name || '';
  let password = '';
  if (!scope.owner) {
    username = required(form, 'username', '로그인 아이디', 64);
    if (!/^[a-zA-Z0-9._-]{4,64}$/.test(username))
      throw new OperationError(
        '아이디는 영문·숫자·마침표·밑줄·하이픈으로 4자 이상 입력해 주세요.',
      );
    if (one(db, 'SELECT 1 FROM accounts WHERE username=?', username))
      throw new OperationError('이미 사용 중인 아이디입니다.', 409);
    ownerName = required(form, 'ownerName', '원장 이름', 80);
    const raw = form.get('password');
    if (
      typeof raw !== 'string' ||
      raw.length < 12 ||
      raw.length > 128 ||
      raw !== form.get('passwordConfirm')
    )
      throw new OperationError(
        '비밀번호를 12자 이상 입력하고 확인란에 같은 값을 입력해 주세요.',
      );
    password = raw;
  }
  takeLimit(db, scope, 'register');
  db.prepare('INSERT INTO academies(id,name) VALUES(?,?)').run(academyId, name);
  db.prepare(
    "INSERT INTO accounts(id,academy_id,username,name,role,student_id,password_hash) VALUES(?,?,?,?,'admin',NULL,?)",
  ).run(
    profileId,
    academyId,
    username,
    ownerName,
    scope.owner ? '!' : hashPassword(password),
  );
  if (scope.owner)
    db.prepare(
      'INSERT INTO op_academy_memberships(login_id,profile_id) VALUES(?,?)',
    ).run(scope.owner.id, profileId);
  db.prepare(
    `INSERT INTO op_academy_profiles
    (academy_id,creator_id,submission_scope,request_id,address,phone,course,category,district,source,official_key)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    academyId,
    scope.owner?.id ?? profileId,
    scope.key,
    requestId,
    address,
    phone,
    course,
    category,
    district,
    official ? JSON.stringify({ ...official, fetchedAt }) : null,
    officialKey,
  );
  return profileId;
}
