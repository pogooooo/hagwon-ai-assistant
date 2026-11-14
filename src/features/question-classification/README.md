# 텍스트 숙제 분류

PNG·JPEG 사진도 같은 명령으로 분류한다. 한 문항만 잘라낸 사진은 문항의 `text` 대신 `image`에 입력 JSON 기준의 상대 경로를 지정한다. 여러 문항이 담긴 쪽 사진은 최상위 `photos` 배열에 `{ "page": 7, "image": "page7.png" }`처럼 지정하면 판독이 문항 경계를 나누고, 인쇄된 번호를 `displayNumber`로 삼아 `숙제ID-p쪽수-번호` 형태의 문항 ID를 만든다. 같은 번호가 두 번 감지되면 그 번호는 `unreadable`로 전달한다. 아래 예시는 실제 사진 대신 수학 1번을 인쇄 형태로 만든 PNG다.

```sh
npm run classify -- src/features/question-classification/examples/math-image-demo.json out/image-demo 1
```

수학 사진은 HCX-005로 두 번 읽고(두 번째는 검수 지시), 표기 차이(예: `a³`, `a^{3}`)만 허용해 비교한다. 차이가 남거나 어느 한쪽에 `[불명]`이 있으면 해당 문항은 HCX-007 호출에서 제외하고 `unreadable`로 전달한다. 두 번 같은 오독을 하면 이 비교로는 못 잡으므로, 통과한 전사를 사진과 직접 대조하는 교차 검수를 한 번 더 요청해 `차이`가 나온 문항도 보류한다. 그래도 세 번 모두 같은 오독이면 잡지 못한다. 영어 사진은 한 번 판독한다.

판독은 문항마다 그림·표·그래프 정보도 수집한다. 그림 의존도(필수/보조/없음)와 항목별 읽은 방식(적힌 값/눈금에서 읽음/모양에서 추정)·상태(선명/불명)를 기록하고, 두 판독에서 갈린 항목은 불명으로 바꾼다. 분류할 때 이 정보를 원문 뒤에 `[그림N]` 줄로 붙여 보내고, 태그의 인용이 `[그림N]` 줄을 가리키면 전달 파일의 `evidenceKind`를 `figure`(또는 본문과 섞이면 `text_and_figure`)로 적는다. 그림 의존도가 필수인데 인용 근거가 추정·불명 그림 정보뿐인 태그는 프로그램이 보류로 바꾼다. 설계 문서의 "그림 원본을 풀이 모델에 직접 보여 준다"는 아직 구현하지 않았고, 글로 옮긴 그림 정보만 분류 모델에 전달한다.

통과한 문항은 첫 전사문 그대로 분류하고 인용을 검사한다. 판독문·토큰 수·보류 이유는 `evidence/`에서 확인한다. 다시 분류할 때는 `out/image-demo/transcribed/math-image-demo.json`을 입력으로 쓰면 사진 판독 비용이 들지 않고, 저장된 그림 정보와 그림 보류 규칙도 그대로 적용된다. 보류된 문항은 여기에 빈 원문으로 저장된다. 사진을 보고 정확한 원문을 확인한 뒤 입력하면 다시 분류할 수 있다. 상담 담당자에게 전달할 파일은 `out/image-demo/classification/math-image-demo.json`이다.

Node.js 24에서 `npm ci` 후 실행한다. 프로젝트 루트의 `.env.local`에 `CLOVA_STUDIO_API_KEY=발급받은키`를 설정한다. 기존 `RAG_CLOVA_API_KEY`도 사용할 수 있다. 기본 모델은 `HCX-007`이며 `CLASSIFICATION_MODEL`로 변경할 수 있다. 각 실행은 해당 과목 기준서와 문항 ID·원문을 [CLOVA Studio Chat Completions v3](https://api.ncloud-docs.com/docs/clovastudio-chatcompletionsv3)로 전송한다. 입력 형식은 `examples/math-demo.json`과 `examples/english-demo.json`을 참고한다.

```sh
npm run classify -- src/features/question-classification/examples/math-demo.json out/question-classification 3
npm run classify -- src/features/question-classification/examples/english-demo.json out/question-classification 3
node src/features/question-classification/examples/evaluate.mjs out/question-classification
```

마지막 인자는 숙제 전체를 독립적으로 분류하는 횟수(기본 1, 평가 시 3)다. 성공하면 지정한 폴더 아래 `classification/{assignmentId}.json`을 상담 담당자에게 전달한다. 원문, 모델, 근거, 인용 검사, 반복별 판정은 `evidence/`에 따로 저장한다. 재실행하면 같은 숙제의 파일을 교체한다.

전달 파일은 첫 실행의 판정을 사용한다. `agreement`는 같은 문항에서 첫 실행과 같은 태그·상태가 나온 횟수다. 세 번 실행했을 때 한 번이라도 갈린 태그는 `held`로 전달한다. 채택 태그가 없으면 전달용 태그 배열을 비우고 보류 사유는 근거 파일에 남긴다. 예시 평가는 채택 태그 집합이 기준서와 정확히 일치하는지, 세 실행에서 태그나 상태가 달라졌는지 집계한다. 이 예시들은 모델에도 제공되는 기준서에서 골랐으므로 개발 확인용이다.
