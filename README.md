# hagwon-ai-assistant

학원 운영 서비스(Node.js·SQLite·RAG)와 Next.js·Capacitor 프로토타입을 포함합니다. 기본 실행은 통합 운영 서비스입니다.

## 시작

Node.js **24.19.0**, npm **11.x**를 두 사람 모두 사용합니다. 버전 관리 도구를 쓴다면 `.nvmrc` 또는 `.node-version`을 읽어 주세요.

```sh
npm ci
npm run dev
```

[http://127.0.0.1:8791](http://127.0.0.1:8791)에서 확인합니다. 가상 계정 `TA_DIRECTOR` / `axr-demo`를 사용합니다. `.env.example`을 `.env.local`로 복사해 Gemini 키·모델·포트를 설정할 수 있습니다. `.env.local`은 Git에서 제외됩니다.

운영 경로·팀 결과 수신·AI 변경 방법·검증 결과는 [운영 서비스 안내](src/features/academy-operations/README.md)를 참조합니다. Next 프로토타입은 `npm run dev:prototype`으로 3000번 포트에서 실행합니다. `build`/`start`/Capacitor는 그 프로토타입 전용이며 운영 서버·DB를 정적 파일에 포함하지 않습니다.

학원 운영 화면은 `npm run academy:dev`로 실행합니다. 접속 주소와 가상 계정은 [학원 운영 실행 안내](src/features/academy-operations/README.md)를 참고하세요.

## 준비한 라이브러리

| 용도             | 라이브러리                           | 현재 상태                                          |
| ---------------- | ------------------------------------ | -------------------------------------------------- |
| 웹               | Next.js, React, TypeScript           | 빈 App Router 페이지                               |
| 앱 패키징        | Capacitor core / CLI / Android / iOS | 설정 및 플랫폼 생성 명령 준비                      |
| 스타일           | styled-components                    | 컴파일러 및 SSR 스타일 레지스트리 연결             |
| 클라이언트 상태  | Zustand                              | 설치만 완료                                        |
| 서버 데이터 캐시 | TanStack Query                       | 설치만 완료, 사용 시 QueryClientProvider 연결 필요 |
| HTTP             | Axios                                | 설치만 완료                                        |
| 데이터 검증      | Zod                                  | 설치만 완료                                        |
| 아이콘           | Lucide React                         | 설치만 완료                                        |
| 협업             | ESLint, Prettier, Husky, lint-staged | 포맷 / 커밋 전 검사 / CI 준비                      |

모든 패키지는 정확한 버전과 `package-lock.json`으로 관리합니다.

Capacitor는 CLI의 간접 의존성 보안 공지를 피하기 위해 전체 패키지를 8.4.3으로 맞췄습니다. ESLint는 Next.js의 React/Import 플러그인과 호환되는 9.x를 사용합니다. 업그레이드할 때는 관련 패키지의 호환성과 `npm audit`을 함께 확인합니다.

## 폴더

```text
src/
  app/          # 라우트, 공통 레이아웃, 최소 전역 CSS
  components/   # 여러 기능에서 공유하는 UI
  features/     # 기능별 UI, 로직, API, 타입을 함께 배치
  hooks/        # 공통 훅
  lib/          # 공통 라이브러리 설정
  stores/       # 공통 클라이언트 상태
  styles/       # 공통 스타일과 테마
  types/        # 공통 타입
public/         # 정적 파일
```

`@/`는 `src/`를 가리킵니다. 빈 디렉터리의 `.gitkeep`은 파일이 생기면 삭제해도 됩니다. 스타일이나 상태 관리의 예제 코드는 넣지 않았습니다.

## 명령어

| 명령어                     | 역할                                         |
| -------------------------- | -------------------------------------------- |
| `npm run dev`              | 통합 운영 서비스(기본 8791)                  |
| `npm run build`            | `out/`에 정적 웹 빌드                        |
| `npm start`                | 빌드한 `out/` 미리보기                       |
| `npm run check`            | ESLint + 타입 + 포맷 검사                    |
| `npm run format`           | 포맷 정리                                    |
| `npm run lint:fix`         | 린트 자동 수정                               |
| `npm run cap:add:android`  | 빌드 후 Android 기본 프로젝트 생성, 최초 1회 |
| `npm run cap:add:ios`      | 빌드 후 iOS 기본 프로젝트 생성, 최초 1회     |
| `npm run cap:sync`         | 웹 빌드 및 생성된 네이티브 프로젝트 동기화   |
| `npm run cap:open:android` | Android Studio로 열기                        |
| `npm run cap:open:ios`     | Xcode로 열기                                 |

## Capacitor

현재는 플랫폼 SDK 패키지와 `capacitor.config.ts`만 준비했으며, `android/`, `ios/`는 만들지 않았습니다. 앱 이름과 ID를 정한 뒤 필요한 플랫폼만 생성합니다. 현재 `appId: com.axr.prototype`은 임시값입니다.

```sh
npm run cap:add:android
npm run cap:open:android
```

Android 실행·빌드에는 Android Studio와 해당 SDK가 필요합니다. iOS 프로젝트 생성·빌드는 macOS와 Xcode 환경에서 진행합니다. 플랫폼을 생성한 다음에는 `android/`, `ios/`의 소스와 설정을 Git에 커밋하고, 웹 변경을 반영할 때 `npm run cap:sync`를 실행합니다. 생성된 웹 자산과 로컬 SDK 경로는 커밋하지 않습니다.

Next.js는 `output: 'export'`, Capacitor는 `webDir: 'out'`으로 연결되어 있습니다. 런타임 서버가 없으므로 API Routes, Server Actions, 요청 시 SSR, 서버 cookies 같은 기능은 사용할 수 없습니다. API가 필요해지면 별도 백엔드를 사용하고, 동적 라우트는 빌드 시 `generateStaticParams`로 경로를 확정해야 합니다. 브라우저·네이티브 API는 클라이언트 컴포넌트의 이벤트나 effect에서 사용합니다.

## 2인 협업

자세한 작업 규칙은 [CONTRIBUTING.md](CONTRIBUTING.md)를 참고합니다. 원격 저장소는 [Hj802/hagwon-ai-assistant](https://github.com/Hj802/hagwon-ai-assistant)이며, 기본 브랜치는 `main`입니다.

- 한 작업은 한 브랜치와 한 PR로 나눕니다. 다른 한 사람이 확인한 뒤 `main`에 합칩니다.
- 작업 전에 담당할 기능 폴더를 나누고, 공통 레이아웃·설정·패키지는 변경 전에 공유합니다.
- 커밋 시 변경 파일에 ESLint/Prettier가 실행됩니다. PR과 `main` push에서는 전체 검사와 정적 빌드가 실행됩니다.
- GitHub에 올린 뒤 `main` 보호 규칙에서 CI 통과와 리뷰 1인을 직접 설정하면 됩니다.
- Windows/macOS 간 줄바꿈은 LF로 통일합니다.

## 공식 참고

- [Next.js 정적 내보내기](https://nextjs.org/docs/app/guides/static-exports)
- [Next.js styled-components 설정](https://nextjs.org/docs/app/guides/css-in-js)
- [Capacitor 설치와 플랫폼 생성](https://capacitorjs.com/docs/getting-started)
