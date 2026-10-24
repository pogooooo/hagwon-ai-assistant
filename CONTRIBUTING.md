# 2인 협업 규칙

## 작업 흐름

1. 작업 전 `main`을 최신화하고 작업 범위를 서로 공유합니다.
2. `feat/짧은-작업명`, `fix/짧은-작업명`, `chore/짧은-작업명` 브랜치에서 작업합니다.
3. 가능하면 각자 다른 `src/features/<기능명>/` 폴더를 맡습니다. 라우트 파일은 조합만 하고 기능 코드와 스타일은 담당 폴더에 둡니다.
4. `npm run check`, `npm run build`를 확인한 뒤 PR을 만듭니다.
5. 다른 팀원이 리뷰하고 CI가 통과하면 squash merge합니다. 다음 작업은 최신 `main`에서 시작합니다.

## 충돌을 줄이는 방법

- `src/app/layout.tsx`, `src/app/globals.css`, `src/lib/`, `package.json`, `package-lock.json`, Next/Capacitor 설정은 공통 파일입니다. 동시에 수정할 때는 먼저 담당자를 정합니다.
- 공통 컴포넌트로 옮기는 작업은 실제 재사용이 생길 때 진행합니다.
- 파일 전체를 정리하는 변경과 기능 변경은 PR을 나눕니다.
- 의존성은 npm만 사용합니다. `npm install 패키지명` 후 `package.json`과 `package-lock.json`을 함께 커밋합니다. 다른 팀원은 pull 후 `npm ci`로 맞춥니다.
- lockfile 충돌은 한 사람의 의존성 변경을 기준으로 다른 변경을 다시 `npm install`해 해결하고 전체 검사를 실행합니다.
- 환경 변수 이름은 `.env.example`로 공유합니다. 실제 값은 `.env.local`에 두며, 클라이언트에 전달되는 `NEXT_PUBLIC_` 값에는 비밀을 넣지 않습니다.
- 네이티브 플랫폼을 생성한 뒤에는 네이티브 설정 변경도 PR에서 공유합니다. 웹 빌드와 SDK 빌드는 별개이며, 현재 CI는 웹만 검사합니다.

## 도구

Node/npm 버전은 README와 버전 파일을 따릅니다. `npm ci`가 Husky를 연결하며, 커밋 전 lint-staged가 변경 파일만 포맷·검사합니다. 전체 타입 검사와 빌드는 PR 전에 직접 실행하고 CI에서도 확인합니다.

커밋 제목 예: `feat: 로그인 폼 추가`, `fix: 입력값 검증 수정`, `chore: 라이브러리 설정 변경`.
