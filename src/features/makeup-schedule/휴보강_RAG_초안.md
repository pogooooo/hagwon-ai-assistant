# 휴·보강 일정 RAG 문서 초안

작성 2026-11-09 · RAG 담당(현정 님) 전달용

> **모든 학원·반·일정은 테스트용 가상 데이터다.** 형식은 아직 RAG 담당과 합의 전인 제안안이다.

## 1. 넣는 규칙

| 규칙             | 내용                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| 넣는 것          | 원장이 **확정**한 휴강·보강만 넣는다                                     |
| 넣지 않는 것     | 미확정·검토 중 일정. 이전 버전은 `search_enabled: false`로 검색에서 뺀다 |
| 단위             | 일정 변경 1건을 문서 1개로 만든다. 날짜·요일·시간·반을 본문에 모두 쓴다  |
| 값의 출처        | 날짜·시간·반은 일정 DB의 저장값을 그대로 넣는다. LLM이 만들지 않는다     |
| 권한             | `visibility`에 적힌 역할과 `class_id`로 검색 전에 거른다                 |
| 자료에 없는 질문 | 추측하지 않고 담당자 연결로 답한다                                       |

## 2. 메타데이터

| 필드             | 설명                               |
| ---------------- | ---------------------------------- |
| `doc_id`         | 문서 고유값                        |
| `doc_type`       | `class_cancel`, `makeup`, `policy` |
| `academy_id`     | 학원 식별자                        |
| `class_id`       | 대상 반. 전체면 `ALL`              |
| `event_id`       | 같은 휴강과 보강을 묶는 값         |
| `status`         | RAG에는 `confirmed`만 들어간다     |
| `version`        | 변경될 때마다 1씩 증가             |
| `supersedes`     | 대체한 이전 `doc_id`               |
| `search_enabled` | 검색 포함 여부                     |
| `event_date`     | 해당 일정 날짜(YYYY-MM-DD)         |
| `confirmed_at`   | 원장 확정 시각                     |
| `visibility`     | 조회 가능 역할                     |

## 3. 가상 학원

- `academy_id`: `TEST-A` / 이름: [가상] 테스트 교습소 / 원장 1명, 교실 1개
- 정규 수업

| class_id | 반        | 요일  | 시간        |
| -------- | --------- | ----- | ----------- |
| E-MATH   | 초등 수학 | 월·수 | 16:00~17:20 |
| M2-EXAM  | 중2 내신  | 월·수 | 18:00~19:50 |
| M3       | 중3       | 화·목 | 18:00~19:50 |
| H1       | 고1       | 화·목 | 20:00~21:50 |

## 4. RAG 입력 문서

아래 문서는 그대로 잘라 넣을 수 있도록 하나씩 구분했다.

---

```yaml
doc_id: TEST-A-CANCEL-001
doc_type: class_cancel
academy_id: TEST-A
class_id: M2-EXAM
event_id: EV-001
status: confirmed
version: 1
supersedes: null
search_enabled: true
event_date: 2026-11-11
confirmed_at: 2026-11-09T10:00:00+09:00
visibility: [guardian, student, teacher, director]
```

[가상] 테스트 교습소 중2 내신반은 2026년 11월 11일 수요일 18:00~19:50 수업이 휴강입니다. 이 휴강의 보강은 2026년 11월 14일 토요일 14:00~15:50으로 확정되었습니다.

---

```yaml
doc_id: TEST-A-MAKEUP-001
doc_type: makeup
academy_id: TEST-A
class_id: M2-EXAM
event_id: EV-001
status: confirmed
version: 1
supersedes: null
search_enabled: true
event_date: 2026-11-14
confirmed_at: 2026-11-09T10:00:00+09:00
visibility: [guardian, student, teacher, director]
```

[가상] 테스트 교습소 중2 내신반 보강은 2026년 11월 14일 토요일 14:00~15:50입니다. 2026년 11월 11일 수요일 휴강에 대한 보강입니다.

---

```yaml
doc_id: TEST-A-CANCEL-002
doc_type: class_cancel
academy_id: TEST-A
class_id: E-MATH
event_id: EV-002
status: confirmed
version: 1
supersedes: null
search_enabled: true
event_date: 2026-11-16
confirmed_at: 2026-11-09T11:00:00+09:00
visibility: [guardian, student, teacher, director]
```

[가상] 테스트 교습소 초등 수학반은 2026년 11월 16일 월요일 16:00~17:20 수업이 휴강입니다.

---

```yaml
doc_id: TEST-A-MAKEUP-002-V1
doc_type: makeup
academy_id: TEST-A
class_id: E-MATH
event_id: EV-002
status: confirmed
version: 1
supersedes: null
search_enabled: false
event_date: 2026-11-21
confirmed_at: 2026-11-09T11:00:00+09:00
visibility: [guardian, student, teacher, director]
```

(변경되어 검색에서 제외됨) [가상] 테스트 교습소 초등 수학반 보강은 2026년 11월 21일 토요일 10:00~11:20입니다.

---

```yaml
doc_id: TEST-A-MAKEUP-002-V2
doc_type: makeup
academy_id: TEST-A
class_id: E-MATH
event_id: EV-002
status: confirmed
version: 2
supersedes: TEST-A-MAKEUP-002-V1
search_enabled: true
event_date: 2026-11-21
confirmed_at: 2026-11-09T15:00:00+09:00
visibility: [guardian, student, teacher, director]
```

[가상] 테스트 교습소 초등 수학반 보강은 2026년 11월 21일 토요일 13:00~14:20입니다. 2026년 11월 16일 월요일 휴강에 대한 보강이며, 이전에 안내한 10:00 시작 일정에서 변경되었습니다.

---

```yaml
doc_id: TEST-A-CANCEL-003
doc_type: class_cancel
academy_id: TEST-A
class_id: M3
event_id: EV-003
status: confirmed
version: 1
supersedes: null
search_enabled: true
event_date: 2026-11-19
confirmed_at: 2026-11-09T16:00:00+09:00
visibility: [guardian, student, teacher, director]
```

[가상] 테스트 교습소 중3반은 2026년 11월 19일 목요일 18:00~19:50 수업이 휴강입니다. 이 휴강의 보강 일정은 아직 확정되지 않았습니다. 보강 일정 문의는 담당자에게 연결합니다.

---

```yaml
doc_id: TEST-A-POLICY-001
doc_type: policy
academy_id: TEST-A
class_id: ALL
event_id: null
status: confirmed
version: 1
supersedes: null
search_enabled: true
event_date: null
confirmed_at: 2026-11-09T09:00:00+09:00
visibility: [visitor, guardian, student, teacher, director]
```

[가상] 테스트 교습소의 휴강·보강 안내는 원장이 확정한 일정을 기준으로 합니다. 휴강에 따른 환불 여부와 금액은 상담봇이 판단하지 않으며 담당자가 확인하여 안내합니다.

## 5. RAG에 넣지 않는 예시

| 상태    | 내용                                    | 처리                       |
| ------- | --------------------------------------- | -------------------------- |
| 검토 중 | 고1반 11월 26일 목요일 시험 대비 보강안 | 원장 확정 전까지 넣지 않음 |

## 6. 검증 질문 예시

| 질문자             | 질문                        | 기대 답변                                      | 평가                 |
| ------------------ | --------------------------- | ---------------------------------------------- | -------------------- |
| 중2 내신반 보호자  | 이번 주 수요일 수업 있나요? | 11/11(수)은 휴강, 보강은 11/14(토) 14:00~15:50 | 최신 일정            |
| 초등 수학반 보호자 | 보강 몇 시예요?             | 11/21(토) 13:00~14:20                          | 10:00을 답하면 오답  |
| 중3반 보호자       | 19일 수업 보강은 언제예요?  | 아직 확정되지 않았고 담당자 연결               | 날짜를 지어내면 오답 |
| 고1반 보호자       | 26일에 보강 있나요?         | 확정된 일정이 없어 담당자 연결                 | 검토안 노출 시 오답  |
| 초등 수학반 보호자 | 휴강하면 얼마 환불돼요?     | 담당자가 확인해 안내                           | 금액 생성 시 오답    |
| 신규 방문자        | 중3반 이번 주 휴강해요?     | 반 일정은 조회 권한이 없어 담당자 연결         | 권한 위반 시 오답    |

## 7. 현정 님과 합의할 것

1. 메타데이터 필드 이름과 필터 방식이 현재 권한 기반 검색과 맞는지
2. 신규 방문자에게 반별 휴강을 공개할지. 초안은 비공개다
3. 일정이 변경될 때 이전 문서를 삭제할지, `search_enabled: false`로 남길지. 초안은 이력 보존을 위해 남긴다
4. 정답 판정 기준: 최신 일정 일치와 올바른 `doc_id` 참조 중 무엇을 기준으로 할지
