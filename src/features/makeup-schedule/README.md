# 휴·보강 일정 RAG 문서 (기능 13)

> **모든 학원·반·원생·일정은 테스트용 가상 데이터다.** 필드와 폴더는 `rag-consultation/server/__fixtures__/academies-v1/FORMAT.md`를 따른다.

`academies/AC_TEST_A/`는 원장이 확정한 휴강·보강이 RAG 문서로 어떻게 들어가는지 보여 주는 예시다. `__fixtures__`는 원본을 수정하지 않는 폴더이므로 이곳에 두었고, 아직 평가 하네스에 등록하지 않았다.

## 넣는 규칙

| 규칙         | 내용                                                                    |
| ------------ | ----------------------------------------------------------------------- |
| 넣는 것      | 원장이 확정한 휴강·보강만 `approved_active`로 넣는다                    |
| 넣지 않는 것 | 미확정·검토 중 일정은 문서로 만들지 않는다                              |
| 단위         | 일정 변경 1건을 문서 1개로 만든다. 날짜·요일·시간·반을 본문에 모두 쓴다 |
| 값의 출처    | 날짜·시간·반은 일정 DB의 저장값을 그대로 넣는다. LLM이 만들지 않는다    |
| 권한         | 반별 휴강·보강은 `class_members`와 `class_id`로 검색 전에 거른다        |
| 일정 변경    | 같은 `document_id`의 `revision`을 올리고 r1의 `valid_to`를 r2 시작으로  |
| 환불         | 금액을 판단하지 않고 담당자가 안내한다                                  |

## 초안에서 바뀐 필드

| 초안                     | 팀 형식                                     |
| ------------------------ | ------------------------------------------- |
| `doc_id`                 | `document_id`                               |
| `doc_type`               | `document_type` (`announcement`, `policy`)  |
| `version`, `supersedes`  | `revision`                                  |
| `status: confirmed`      | `status: approved_active`                   |
| `search_enabled: false`  | r1의 `valid_to`로 효력 종료                 |
| `confirmed_at`           | `approved_at`, `valid_from`                 |
| `visibility`의 역할 목록 | `class_members` 또는 `academy_public`       |
| `event_date`             | `facts.jsonl`의 `schedule_change`의 `date`  |
| `event_id`               | 대응 필드 없음. 휴강과 보강은 본문으로 연결 |
| 역할 `director`          | 역할 `admin`                                |

## 현정 님과 확인할 것

1. 기존 평가 자료에는 `class_members` 문서가 없다. 이 값으로 정형 조회와 답변까지 끝까지 동작하는지
2. 일정 변경을 `revision`으로 처리하는 방식이 맞는지. 초안의 `event_id`가 따로 필요한지
3. 반별 휴강을 신규 방문자에게 비공개로 두는 기준이 맞는지
4. 이 폴더를 평가 하네스에 넣을지, 넣는다면 어디에 둘지
