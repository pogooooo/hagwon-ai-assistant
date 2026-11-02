# 가상 학원 3곳 RAG 테스트 자료 — 형식 규칙 (academies-v1)

> 모든 학원·원생·보호자·강사·주소·전화번호는 **테스트용 가상 데이터**다. 실제 개인정보·실제 학원과 섞지 않는다.
> 기준 시점: 2026년 11월 2일(월). 테스트 질문의 `as_of` 는 2026-11-02 ~ 2027-01-15 사이.

## 폴더

```text
academies-v1/
  FORMAT.md                 # 이 문서
  validate_academies.py     # 형식·참조·사실↔원문 일치 검사 (python3 -I validate_academies.py)
  <ACADEMY_ID>/
    academy.json            # 학원 카탈로그(반·단원·문항 유형)
    users.json              # 가상 계정과 서버 권한
    students.json           # 원생 명부(서버 전용: 이름·별칭·반)
    documents/*.md          # 학원 원본 파일과 원생 분석 리포트(front matter + 본문)
    facts.jsonl             # 3·7번 기능이 만든 정형 사실(원문에서 그대로 확인 가능한 값만)
    cases.jsonl             # 테스트 질문과 기대 결과
```

## academy.json

```json
{
  "academy_id": "AC_GAON",
  "display_name": "가온수학학원",
  "aliases": ["가온수학", "가온"],
  "classes": [
    { "class_id": "GA_M2_ADV", "name": "중2 심화반", "aliases": ["중2 심화", "중2S"], "subject": "수학", "grade": "중2" }
  ],
  "units": ["일차함수와 그래프", "도형의 닮음"],
  "question_types": ["계산", "개념", "응용", "서술형"]
}
```

- `units`, `question_types` 는 이 학원 분석 리포트에 실제로 등장하는 이름만 넣는다.
- 반 `aliases` 는 학부모가 실제로 부를 법한 표현(학년 포함 형태 권장).

## users.json

```json
[
  { "user_id": "GA_GUARDIAN_KIM", "role": "guardian", "academy_id": "AC_GAON",
    "allowed_student_ids": ["GA_STU_001", "GA_STU_002"], "allowed_class_ids": [],
    "student_aliases": { "GA_STU_001": ["첫째", "큰애"], "GA_STU_002": ["둘째", "작은애"] } }
]
```

- role: `visitor | student | guardian | teacher | admin`
- 강사는 담당 반 원생만 `allowed_student_ids` 에 넣는다(서버가 계산했다고 가정).
- `student_aliases` 는 선택(형제 지칭 등 이 계정에서만 쓰는 별칭).

## students.json

```json
[
  { "student_id": "GA_STU_001", "academy_id": "AC_GAON", "name": "김서준",
    "aliases": ["서준", "서준이"], "class_ids": ["GA_M3_ADV"] }
]
```

- 학생 ID 는 `<접두>_STU_<3자리>` 형식(예: `GA_STU_001`).
- `aliases` 는 이름(성 제외)과 부르는 말. 다른 학생과 겹치면 안 된다.

## documents/*.md

파일명: `<document_id>__r<revision>.md`

```markdown
---
document_id: GA_FEE_2026_2
revision: 1
document_type: fee
title: 가온수학학원 2026년 2학기 수강료 안내
status: approved_active
visibility: academy_public
class_id: null
student_id: null
valid_from: 2026-09-01T00:00:00+09:00
valid_to: 2027-01-01T00:00:00+09:00
approved_at: 2026-08-20T10:00:00+09:00
---

# 2026년 2학기 수강료 안내
...
```

- `document_type`: `academy_info | fee | schedule | policy | facility | teacher | announcement | student_analysis | guidance`
- `status`: `approved_active` 또는 `draft`(미승인 — 검색되면 실패)
- `visibility`: 학원 공개 자료 `academy_public`, 원생 리포트 `student_private`(반드시 `student_id`)
- 시간은 `+09:00` 오프셋 포함 ISO-8601. `valid_to` 는 배타적 경계(`[from, to)`), 없으면 `null`.
- 같은 문서의 개정판은 같은 `document_id` 에 `revision` 을 올린다(예: 채점 수정판 r2). 효력 기간이 다른 별도 공지는 다른 `document_id` 를 써도 된다.
- 표는 Markdown 표(`|헤더|...|` + `|---|`)로, 섹션은 `##` 제목으로 구분한다.
- 원생 리포트 본문에는 분석 기간, 대상 숙제 목록(제목·제출일), 단원별·유형별 표(정답 문항/전체 문항), 취약 영역, 강사 확인 학습 방향, 작성·수정 시점을 적는다.

## facts.jsonl (한 줄 = 사실 1개)

공통 필드:

```json
{ "fact_id": "GA_F_FEE_M2ADV_2026_2", "document_id": "GA_FEE_2026_2", "revision": 1,
  "academy_id": "AC_GAON", "subject_type": "class", "subject_id": "GA_M2_ADV",
  "fact_type": "monthly_fee", "value": { "kind": "money", "amount": 320000, "currency": "KRW" },
  "period": null, "valid_from": "2026-09-01T00:00:00+09:00", "valid_to": "2027-01-01T00:00:00+09:00" }
```

- `subject_type`: `class`(반) / `academy`(학원 전체, subject_id = academy_id) / `student`(subject_id = 문서의 student_id)
- 사실의 유효 기간은 문서 유효 기간 안에 있어야 한다.

| fact_type | subject | value |
| --- | --- | --- |
| `monthly_fee` | class | `{ "kind": "money", "amount": 320000, "currency": "KRW" }` |
| `material_fee` | class | `{ "kind": "money", "amount": 25000, "currency": "KRW" }` (교재비) |
| `schedule` | class | `{ "kind": "schedule", "text": "월·수·금 17:00~18:50" }` |
| `teacher` | class | `{ "kind": "text", "text": "박지훈 강사" }` |
| `enrollment_status` | class | `{ "kind": "enrollment", "status": "open", "capacity": 8, "remaining": 2, "text": "모집 중 (잔여 2석)" }` — status: `open/waitlist/closed`, 숫자 모르면 null |
| `schedule_change` | academy 또는 class | `{ "kind": "schedule_change", "change_type": "cancel", "date": "2026-11-19", "time": null, "text": "수능일 전체 휴강" }` — change_type: `cancel/makeup` |
| `makeup_policy` | academy | `{ "kind": "text", "text": "..." }` |
| `facility` | academy | `{ "kind": "text", "text": "자습실 운영 (평일 14:00~22:00)" }` |
| `accuracy` | student | `{ "kind": "accuracy", "correct": 13, "total": 20, "unit": "도형의 닮음", "dimension": "unit" }` — dimension: `unit/question_type/overall`(overall 이면 unit 은 "전체") |
| `weak_area` | student | `{ "kind": "weak_area", "unit": "도형의 닮음", "text": "..." }` (3번 기능이 판정한 취약 영역) |
| `learning_guidance` | student | `{ "kind": "text", "text": "..." }` (강사가 확인한 학습 방향) |

학생 사실은 추가로 `"period": "2026-10"`, `"assignments": [{"assignment_id": "GA_HW_1012", "title": "10월 2주 닮음 기본 숙제"}]`, `"evidence": "5·7·12번 오답"`(선택)을 둔다.

**사실 ↔ 원문 일치 규칙**(검사기가 확인): 금액은 원문에 `320,000` 형태로, 정답률 사실의 정답 수·전체 문항 수는 원문의 **같은 줄**에, `text`·`schedule.text`·취약 영역 `text` 는 원문에 **그대로**(공백 무시) 있어야 한다. 휴보강 날짜는 원문에 `11월 19일` 또는 `2026-11-19` 로 있어야 한다.

## cases.jsonl

```json
{ "case_id": "GA-001", "split": "dev", "category": "public_faq", "tags": ["fee"],
  "input": { "user_id": "GA_VISITOR", "query": "중2 심화반 한 달 수강료가 얼마예요?",
             "as_of": "2026-11-02T15:00:00+09:00", "session": {}, "api_state": "ok" },
  "expected": { "status": "answered", "fact_ids": ["GA_F_FEE_M2ADV_2026_2"],
                "source_ids": ["GA_FEE_2026_2:r1:body"], "generation_budget_max": 0,
                "must_include": ["320,000원"], "must_not_include": ["350,000원"] } }
```

- `fact_ids`/`source_ids` 는 **반드시 필요한 최소 근거**(서로 개수가 달라도 됨). `source_id` = `<document_id>:r<revision>:body`
- `must_include` / `must_not_include`: 답변 문장에 반드시 있어야/없어야 하는 문자열(금액은 `320,000원`, 정답률은 `13문항`, `65%` 같은 형태).
- `session` 키: `selected_student_id`, `candidate_student_ids`, `selected_period`(YYYY-MM)
- `api_state`: `ok | 429 | 5xx | timeout | quota_exhausted`
- 기대 상태 규칙
  - `answered`: 승인 자료로 질문의 필수 조건(반·기간·학생·단원)을 모두 확인
  - `partial`: 일부만 확인(예: 비교할 다른 달 자료 없음, 규정에 횟수 없음)
  - `abstained`: 자료에 없음(주차 요금이 자료에 없다 등), 원인·태도·성적 예측 요청, 자료끼리 충돌
  - `clarify`: 보호자 자녀가 둘 이상인데 누구인지 불명확
  - `denied`: 다른 학원, 권한 밖 원생(이름으로 불러도), 전체 원생 정보, 링크 공유·권한 변경 요청
  - `handoff`: 승인된 학습 방향이 없는 원생에게 학습 방향/서술형 상담을 요청했는데 생성 API 가 장애(429/5xx/quota)
- `generation_budget_max`: 승인 학습 방향이 없는 원생의 학습 방향 상담(api ok)만 1, 나머지는 0
