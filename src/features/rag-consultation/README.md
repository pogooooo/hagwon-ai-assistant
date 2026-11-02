# 4. 파일 기반 RAG 상담 (rag-consultation)

학원 문서(PDF·스캔 PDF·DOCX·HWPX·TXT·Markdown)와 원생 분석 리포트를 근거로 상담 답변을 만들고, 근거를 쪽·절·표 위치까지 인용합니다. 자료로 답할 수 없으면 지어내지 않고 보류하거나 담당자 연결 상태를 돌려주는 **독립 서버 모듈**입니다.
3·5·7·8·9번 기능이 없어도 합성 데이터와 mock 어댑터로 전체 흐름을 실행하고 테스트할 수 있습니다.

> ⚠️ 모든 테스트 데이터는 완전한 가상 데이터입니다. 합성 데이터에서 테스트가 통과했다고 실제 원생 개인정보를 다루는 운영 환경이 안전하다는 뜻은 아닙니다.
> 외부 생성 API 연동은 **검증되지 않았습니다**(키·공급자 미선정, 약관·개인정보 처리 조건 미확인). 원생 개인정보는 외부 API 로 보내지 않습니다(기본 `RAG_GENERATION_ALLOW_PERSONAL_DATA=false`).

| 문서                             | 내용                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| 이 README                        | 구조·실행법·API·통합 계약·남은 위험                                                   |
| [REPORT.md](REPORT.md)           | 범위 재정비 분류표, 기술별 적용 여부·파일·라이브러리, 제거·유지 항목, 남은 문제       |
| [TEST_REPORT.md](TEST_REPORT.md) | 미공개 평가(393문항) 포함 모든 평가 결과, 단계별 오류, 지연·CPU·RAM, 보안·권한 테스트 |
| [DEMO.md](DEMO.md)               | 실제 실행 결과로 만든 질문·답변 예시 18개와 API 호출 예                               |

---

## 1. 동작 범위 요약

| 영역      | 상태                                                                                                                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 문서 파싱 | PDF(글자 위치로 표·2단 편집·여러 쪽 표 복원), 스캔 PDF(tesseract.js OCR, 회전 판별·판독 불확실 숫자 표시), DOCX·HWPX(제목·표), TXT(EUC-KR), 개인정보 가림, 크기·쪽·압축 해제 제한 |
| 색인·출처 | 절·문단·표 행 단위 청크, **쪽 번호·절·표·행 위치**, revision·유효기간·승인 상태, 중복 업로드 표시, 검수 필요(OCR 저신뢰) 표시                                                     |
| 검색      | 검색 **전에** 권한·승인·유효기간 필터, 기본 BM25. 모델 검색기(e5 하이브리드·bge 재정렬)는 개발·평가 전용(측정 결과 기본값으로 채택하지 않음, TEST_REPORT 6장)                     |
| 답변      | 정형 사실(수강료·재료비·시간표·강사·모집·휴보강·정답률) 코드 조회, 운영 문서 절·표 칸 인용, 리포트 원문 세부(과제별 기록·제출 횟수·채점 수정 이유) — 생성 0회                     |
| 해석      | 규칙 우선 → 규칙이 약하면 원문 검색 근거의 자리로 경로 결정(계층적 라우팅), 답 유형(금액·날짜·마감·인원…) 충분성 검사, 반·날짜·요일·기간 바인딩, 후속 질문, 질문 분해             |
| 안전      | 다른 학원·전체 명단·권한 밖 원생 거부, 등수·성적 통계 보류, 원인·태도·예측 보류, 인용 재조회·숫자 검사·다른 원생 이름 차단, 미승인 초안 제외, OCR 불확실 숫자 사용 금지           |
| 생성      | 강사 확인 학습 방향은 인용(0회), 없을 때만 1회 생성(mock 검증). 실제 외부 API **미검증**                                                                                          |
| 개발 화면 | `npm run rag:dev` → `http://127.0.0.1:8787/dev` (문서 선택·업로드·파싱 보기·검색 순위·단계별 시간·전략·생성 종류)                                                                 |

미구현: 운영 DB·로그인 연동·서버 배포, 구형 HWP(바이너리), 실제 생성 API 연동 검증, 실서버 지연·자원 측정.

---

## 2. 구조

```text
src/features/rag-consultation/
  contract.ts            # 공개 계약(RagAnswer, 요청 스키마) — 클라이언트에서 import 가능
  api/rag-client.ts      # 웹/Capacitor 공용 상담 API 클라이언트(axios)
  server/                # ⚠️ 서버 전용(클라이언트에서 import 금지 — 테스트로 강제)
    service.ts           # 오케스트레이션: 보안 차단 → 분석/정보 라우팅 → 근거 → 충분성 → 0/1회 생성 → 사후 검사
    ports.ts, types.ts   # 다른 기능과 연결할 포트, 도메인 타입
    config.ts            # 주제 정의(사실 유형·근거어·의문사 일반어), 정책 상수
    query/               # 규칙 기반 질의 해석(학생·반·줄임 반 이름·단원·날짜·요일·연산자·보안 신호), 대상 확정
    answer/              # info(정형·절·표 행), evidence(검색 근거 라우팅·답 유형·근거 선택), analysis(정답률·취약·리포트 세부),
                         # advice(학습 방향), verify(숫자·식별자 검사)
    retrieval/           # 권한 필터, BM25, 순위 전략(Dense·RRF·재정렬), 검색기 구성(setup.ts)
    ingest/parsers/      # PDF·OCR·DOCX·HWPX·TXT 파서, 레이아웃 분석(표·2단), 개인정보 가림, 제한
    ingest/              # 쪽·절·표 행 청크, 문서·사실 검증, 파일 → 색인 입력(ingest-file.ts)
    store/               # 메모리 저장소(revision 전환·멱등·중복 표시), 색인 작업 큐
    generation/          # disabled / mock / 회로 차단기 / OpenAI 호환 어댑터, 출력 검증
    http/                # 표준 Fetch 핸들러(query·index(파일 업로드)·jobs), 호출 제한
    adapters/            # 합성·가상 학원 자료 로더(파싱 캐시), 메모리 어댑터, 로컬 모델(개발·평가 전용)
    eval/                # 공통 평가 실행기(run-eval·harness·variants), 문항 디버깅, 파싱 도구, DEMO 생성
    dev/                 # 개발 서버 + 개발 전용 테스트 화면(dev-ui.html), 진단 도구
    __fixtures__/        # axr-synthetic-v1(제공 원본), academies-v1(가상 3곳), academies-v2(개발 1곳 + 미공개 평가 3곳, 동결),
                         # documents-v1(파서 시험 파일), eval-results(평가 결과 JSON/CSV)
    __tests__/           # 회귀·보안·파서·PDF 통합·HTTP·변경 반영·생성 장애·단위 테스트
```

질문 처리 흐름:

```text
요청 검증 → 서버 세션 → RagAccessScope(학원·역할·허용 학생/반)
 → 질의 해석(규칙) → 보안 차단(다른 학원·전체 명단·권한 밖 원생 → denied, 등수·통계·출처 위조 → abstained)
 → 학습 분석: 대상 확정(모호하면 clarify) → 정답률·취약·비교·추이 / 리포트 원문 세부(과제·제출·수정 이유)
 → 학원 정보: 규칙 주제가 뚜렷하면 정형 조회·절 인용
              규칙이 약하거나(주제 없음·의문사만) 반을 정하지 않았으면 → 사용자 원문 검색 → 근거의 자리로 경로 결정
              의문사가 요구하는 값이 답에 없으면 문서 근거로 다시 찾고, 그래도 없으면 보류
 → 사후 검사: 인용 재조회(권한·승인·유효 버전), 숫자 ⊆ 근거·계산값, 다른 원생 이름·코드 없음, OCR 불확실 숫자 없음
```

---

## 3. 실행법

```bash
npm ci
```

```bash
npm test
```

OCR 테스트는 처음 실행할 때 tesseract.js 학습 데이터(kor+eng)를 내려받아 `RAG_MODEL_CACHE_DIR/tesseract`(기본 `~/.cache/axr-rag-models`)에 둡니다. 내려받을 수 없는 환경이면 OCR 테스트는 건너뜁니다. 끄려면:

```bash
RAG_SKIP_OCR=1 npm test
```

개발 서버와 테스트 화면(127.0.0.1 전용, 합성 데이터·모의 세션):

```bash
npm run rag:dev
```

브라우저에서 `http://127.0.0.1:8787/dev` 를 엽니다. 계정을 고르고 문서를 선택(비우면 권한 안의 전체)한 뒤 질문합니다. 관리자 계정(`HK_ADMIN` 등)으로는 파일을 올려 색인할 수 있고, "파싱 미리 보기"로 정규화 Markdown·쪽별 처리 방식·청크 위치를 봅니다. 진단 영역(검색 순위·점수·단계별 시간·전략·생성 종류·trace)은 `/dev/api/*` 에서만 나오며, 운영 경로 `/api/rag/*` 응답에는 들어가지 않습니다.

모델 검색기로 dev 서버를 띄우려면(처음 실행 시 모델 내려받음):

```bash
RAG_DEV_RETRIEVER=dense-rerank npm run rag:dev
```

mock 생성까지 확인하려면:

```bash
RAG_GENERATION_PROVIDER=mock npm run rag:dev
```

평가 실행(결과: `server/__fixtures__/eval-results/<label>/`):

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/features/rag-consultation/server/eval/run-eval.ts --suite v1-paraphrase-100,v1-90,v2-dev --variant rag-bm25,engine --label my-run
```

- `--suite`: `v1-90`(가상 학원 3곳), `v1-paraphrase-100`(중학생 표현), `v2-dev`(개발 학원 153), `v2-test`(미공개 평가 393), `v2-<학원ID>`
- `--variant`: `rag-bm25`(검색 1위 청크 = 답), `engine`(기본), `engine-dense`, `engine-dense-rerank`
- `--no-ocr`: 스캔 PDF OCR 끄기(파싱 결과는 `~/.cache/axr-rag-models/parse-cache` 에 캐시)

개발 문항 하나 디버깅(미공개 평가 자료는 열지 않음):

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/features/rag-consultation/server/eval/debug-case.ts --suite v2-dev --case HK-D-014
```

파일 하나 파싱해 보기:

```bash
node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON src/features/rag-consultation/server/eval/parse-file.ts <파일 경로>
```

### 환경 변수(서버 전용, `.env.example` 참고)

| 이름                                                                        | 의미                                                   | 기본값                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------- |
| `RAG_GENERATION_PROVIDER`                                                   | `disabled` / `mock` / `openai-compatible`              | `disabled`                |
| `RAG_GENERATION_BASE_URL`, `RAG_GENERATION_MODEL`, `RAG_GENERATION_API_KEY` | OpenAI 호환 공급자 연결 정보(하나라도 없으면 disabled) | 없음                      |
| `RAG_GENERATION_ALLOW_PERSONAL_DATA`                                        | 약관·미성년 이용·국외 처리 검토 완료 시에만 `true`     | `false`                   |
| `RAG_GENERATION_DAILY_CALL_LIMIT`                                           | 일일 생성 호출 상한                                    | 제한 없음                 |
| `RAG_MODEL_CACHE_DIR`                                                       | OCR 학습 데이터·로컬 모델·파싱 캐시 위치               | `~/.cache/axr-rag-models` |
| `RAG_DEV_PORT`, `RAG_DEV_RETRIEVER`                                         | dev 서버 포트, 검색기(`bm25`·`dense`·`dense-rerank`)   | `8787`, `bm25`            |
| `NEXT_PUBLIC_RAG_API_BASE_URL`                                              | 클라이언트가 호출할 상담 API 주소(비밀값 아님)         | 없음                      |

### 의존성

- 런타임(파싱에 필요): `pdfjs-dist`(PDF 글자·위치), `@napi-rs/canvas`(스캔 쪽 렌더링), `tesseract.js`(OCR, CPU), `fflate`(DOCX/HWPX 압축 해제). 기존 `zod`, `axios`.
- 개발·평가 전용(devDependencies, 서비스 기본 경로에서 불러오지 않음): `@huggingface/transformers`(e5·bge), `kiwi-nlp`(형태소 실험), `pdf-lib`·`@fontsource/noto-sans-kr`(시험용 PDF 생성).

---

## 4. API 계약

| 처리             | 경로                         | 권한                                                                |
| ---------------- | ---------------------------- | ------------------------------------------------------------------- |
| 상담             | `POST {base}/query`          | 서버 세션 필수(없으면 401). 사용자별 호출 제한(429 + `Retry-After`) |
| 문서 등록·재색인 | `POST {base}/index`          | `admin` 이고 문서의 학원이 세션 학원과 같을 때만                    |
| 색인 상태        | `GET {base}/index/jobs/{id}` | 같은 학원 `admin`. 다른 학원 작업은 404(존재 여부 비노출)           |

상담 요청: `{ "question": string(1~500), "studentId"?: string, "conversationId"?: string }`. `studentId` 는 대상 **힌트**일 뿐이며 `role`·`academyId`·`allowedStudentIds` 를 본문에 넣어도 무시합니다.

상담 응답(`RagAnswer`): `status`, `answer`, `citations[{sourceId, documentId, title, location, revision}]`, `missingFields?`, `clarifyOptions?`, `handoff?`, `requestId`. `location` 예: `1쪽 · 1. 과정별 수업 구성 · 표 1 · 2행`. 내부 trace 는 넣지 않습니다.

색인 요청: `{ approve, document: {academyId, documentId, revision, documentType, title, visibility, validFrom, …}, text? | file?: {fileName, contentBase64} }`. 파일을 보내면 서버가 파싱하고 응답에 `parse`(형식·상태·쪽별 방식·경고)를 돌려줍니다. 파싱 실패는 422, OCR 저신뢰 등은 `reviewRequired: true`.

| status      | 의미                                                                  |
| ----------- | --------------------------------------------------------------------- |
| `answered`  | 필수 근거가 충분하고 인용·숫자 검사 통과                              |
| `partial`   | 일부만 확인됨. `missingFields` 에 미확인 항목                         |
| `abstained` | 자료 없음·충돌·등수/통계·원인/예측 요청 등. 담당자 연결 가능          |
| `clarify`   | 대상 학생이 모호함. `clarifyOptions` 에서 선택                        |
| `denied`    | 권한 범위 밖. 자료 존재 여부·다른 학생 정보를 드러내지 않는 동일 문구 |
| `handoff`   | 생성 필요 상담인데 공급자 장애·미승인·출력 검증 실패                  |

---

## 5. 통합 계약(다른 기능과 연결할 지점)

| 연결 기능          | 포트/이벤트                                                                                                    | 지금 상태           |
| ------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------- |
| 5·8 원생·권한      | `AccessScopePort.resolveFromServerSession(session) → RagAccessScope \| null`                                   | 합성 계정 mock      |
| 5 반·단원 카탈로그 | `CatalogPort.getAcademyCatalog(academyId)`                                                                     | 가상 학원 자료      |
| 3 학습 분석        | `onAnalysisReportPublished(queue, report)` — 확정 정답·문항 수 → 리포트 문서 + 사실, 채점 수정은 revision 증가 | 구현·테스트         |
| 7 자료 관리        | `onDocumentChanged`, `RagDocumentsPort`, `POST /index`(원본 파일 업로드·파싱 포함)                             | 구현·테스트(메모리) |
| 3·7 정형 사실      | `ApprovedFactsPort.queryApprovedFacts`                                                                         | 메모리              |
| 9 상담 이력·담당자 | `HandoffPort`, `ConversationStatePort`(actorId 로 격리)                                                        | 메모리              |
| 14·15 톡톡·음성    | 같은 `POST /query` 계약                                                                                        | 계약만 제공         |
| 웹/Capacitor       | `api/rag-client.ts` 의 `createRagClient({ baseUrl, getAuthHeaders })`                                          | 화면 미구현         |

운영 DB 어댑터가 지켜야 할 불변식은 `server/store/in-memory-store.ts` 상단 주석에 있습니다(검색 전 권한 필터, revision 불변·멱등, 순서 역전 방지, 삭제 즉시 반영, 중복 본문 검색 제외).

---

## 6. 검증 요약

자세한 수치·방법은 [TEST_REPORT.md](TEST_REPORT.md) 에 있습니다. 미공개 평가 393문항은 엔진을 고정한 뒤 **한 번만** 실행했습니다.

---

## 7. 남은 위험·결정 필요 사항

1. **서버 실행 위치 미정**: 앱이 정적 export 라서 별도 백엔드가 필요합니다(CORS·인증 방식 포함).
2. **생성 공급자 미선정**: 약관(미성년 이용·국외 처리)을 확인하기 전에는 개인정보 전송 금지 설정을 유지해야 합니다.
3. **규칙 기반 해석의 한계**: 처음 보는 표현·자료에 없는 개념을 묻는 질문에서 과잉 응답이 남아 있습니다(TEST_REPORT 4장 오류 분석). 개념 단위 "자료에 없음" 판정은 잘못된 보류가 48%로 늘어 채택하지 않았습니다(REPORT 3장).
4. **다른 학원 이름 탐지**: 다른 학원은 "OO영어학원"처럼 '학원'이 붙어야 알아봅니다. 붙지 않으면 거부하지 않고 자기 학원 자료로 답합니다(검색은 학원별로 격리되어 다른 학원 자료가 나가지는 않음).
5. **OCR**: 스캔 품질이 낮으면 숫자를 불확실로 표시하고 그 숫자는 답에 쓰지 않습니다(보류 쪽으로 처리). 관리자 검수 흐름은 7번 기능과 함께 정해야 합니다.
6. **메모리 구현**: 저장소·작업 큐·호출 제한·대화 상태는 단일 프로세스 메모리입니다.
7. **법·약관 검토**: 미성년 원생 데이터의 외부 전송·국외 이전·보존 정책은 법무·개인정보 담당 검토가 필요합니다.
