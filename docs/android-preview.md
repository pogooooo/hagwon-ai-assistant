# AXR 모바일 웹앱과 Android 테스트 APK

운영 웹 [AXR 학원](https://axr-academy-hosted.pogoo.workers.dev)을 모바일 홈 화면에 설치할 수 있도록 manifest·아이콘·모바일 메뉴를 제공한다. APK도 같은 HTTPS 운영 웹을 여는 **Trusted Web Activity(TWA)** 방식이다. 서버·DB·Gemini 키를 APK에 넣지 않는다. 기존 Next/Capacitor 프로토타입과 분리되어 있다.

## 이번 빌드

- 패키지: `com.axr.academy.preview`
- 버전: `0.1.0-preview`, versionCode 1
- 최소 SDK 24, 대상/컴파일 SDK 36. 실제 사용에는 TWA를 지원하는 브라우저가 필요하다.
- APK: `AXR-academy-preview-2026-11-17.apk`, 5,019,679바이트
- SHA-256: `c559ea51bfbe98ccf43174d2e82287e3a64ba3a9709826e3340586457a085e60`
- `assembleDebug` 성공, APK v2 서명 검증 성공, 패키지/버전/표시 이름/SDK 확인.
- APK의 URL은 위 운영 HTTPS 주소다. 개발 PC의 localhost를 열지 않는다.
- 실제 휴대폰이 연결되지 않아 설치·브라우저 신뢰 검증·기기 마이크/파일 선택·OS 뒤로가기·배터리 사용은 미검증이다.
- 테스트용 debug 서명이며 Play Store 배포용 release 서명·스토어 등록을 완료한 것은 아니다.

## 빌드 재현

64비트 JDK 17, Android SDK 36, Gradle 8.14.3을 사용했다. 기존 32비트 Java에서는 D8 메모리 할당에 실패했다. 빌드 도구는 실행 서버의 의존성에 추가하지 않았다.

```powershell
npm install --prefix .local/audit-tools --ignore-scripts --no-audit --no-fund @bubblewrap/cli@1.27.0
# JAVA_HOME은 64비트 JDK 경로, ANDROID_HOME은 Android SDK 경로로 설정한다.
node scripts/prepare-android-preview.mjs
.local/android-preview/gradlew.bat -p .local/android-preview assembleDebug --no-daemon --max-workers=2
```

출력은 `.local/android-preview/app/build/outputs/apk/debug/app-debug.apk`다. 생성된 Android 프로젝트와 APK, SDK, 개인 서명 키는 Git에 올리지 않는다. 웹 코드·manifest·아이콘과 프로젝트 생성 스크립트를 버전 관리한다.

## 웹과 앱의 연결 확인

`src/features/academy-operations/.well-known/assetlinks.json`에는 테스트 APK의 **공개 인증서 지문**만 있다. 개인 키는 없다. Cloudflare 준비 스크립트가 이 파일을 `/.well-known/assetlinks.json`에 배포한다.

다른 컴퓨터의 debug 키로 다시 만들면 지문이 달라질 수 있다. 해당 APK의 공개 지문을 확인해 연결 파일을 갱신해야 한다. 앱 서명과 웹 파일이 일치하지 않으면 브라우저 주소창이 있는 Custom Tab으로 열린다. 정식 배포 시에는 별도 release 서명과 새 패키지/버전 정책을 정한다.

현재 앱은 온라인 상담·일정·자료를 사용한다. 오프라인 상태에서는 연결 안내만 표시하고 개인 자료를 캐시하거나 신청을 나중에 재전송하지 않는다. Android APK의 지원 OS 수치만으로 모든 기기에서 사용성을 보장하지 않는다.

설계 근거: [Google의 Trusted Web Activity 안내](https://developer.chrome.com/docs/android/trusted-web-activity/quick-start).
