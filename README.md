# 영업기획관리실 대시보드 — 배포 가이드

Claude(Anthropic) 서버에 의존하지 않고, 무료 서비스(Firebase + GitHub Pages)만으로 크롬 브라우저에서
접속해 쓸 수 있는 팀용 웹앱입니다. 변호사 사건관리 대시보드와 동일한 구조(Firebase Authentication +
Firestore 보안 규칙)를 사용해서, 로그인 화면이 진짜로 데이터베이스 접근을 막아줍니다.

- 데이터 저장: **Firebase Firestore** (무료 Spark 플랜)
- 로그인 보호: **Firebase Authentication** (이메일/비밀번호, 팀 공용 계정 1개)
- 호스팅: **GitHub Pages** (무료 정적 호스팅)

현재 구현된 기능: **주간보고** 탭 → **영업기획팀 / 영업관리팀** 팀별 탭 → **3-layer 구조**
(1차: 프로젝트, 예 GMCS project / 2차: 카테고리, 예 기획·대시보드 / 3차: 주차별 상세내용).
상단 탭 바에 "성과관리", "+ 탭 추가 예정"을 비활성 상태로 미리 넣어두었으니, 다음 기능을
추가할 때 이 탭들을 살리면 됩니다.

---

## 1단계. Firebase 프로젝트 만들기

1. https://console.firebase.google.com 접속 후 구글 계정으로 로그인
2. **"프로젝트 추가"** 클릭 → 프로젝트 이름 입력 (예: `seegene-team-dashboard`) → 애널리틱스는 꺼도 무방 → 프로젝트 생성

### 1-1. Firestore Database 활성화
1. 왼쪽 메뉴 **빌드 > Firestore Database** 클릭 → **"데이터베이스 만들기"**
2. 위치는 `asia-northeast3 (서울)` 선택 (한국 기준 속도가 가장 빠름)
3. 보안 규칙은 **프로덕션 모드**로 선택하세요. (테스트 모드는 30일 후 규칙이 자동으로 "전체 차단"으로
   잠기는데, 아래 1-2단계를 건너뛴 채 넘어가면 어느 날 갑자기 접속이 안 되는 문제가 생길 수 있습니다.
   프로덕션 모드는 처음부터 기본이 "전체 차단"이라 1-2단계에서 규칙을 직접 넣어야만 열립니다.)

### 1-2. 보안 규칙 설정 (중요 — 반드시 진행)
1. Firestore Database 화면에서 **"규칙(Rules)"** 탭 클릭
2. 아래 내용(이 프로젝트의 `firestore.rules` 파일 내용)을 그대로 붙여넣고 **"게시(Publish)"**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /layer1/{docId} {
      allow read, write: if request.auth != null;
    }
    match /layer2/{docId} {
      allow read, write: if request.auth != null;
    }
    match /layer3/{docId} {
      allow read, write: if request.auth != null;
    }
  }
}
```

이 규칙은 **로그인한 사용자만** 주간보고 데이터를 읽고 쓸 수 있게 막아줍니다. 이 단계를 건너뛰면
누구든 인터넷에서 데이터를 열람/수정할 수 있으니 꼭 설정하세요.

### 1-3. 로그인(Authentication) 설정
1. 왼쪽 메뉴 **빌드 > Authentication** → **"시작하기"**
2. **"Sign-in method"** 탭 → **"이메일/비밀번호"** 선택 → 사용 설정 → 저장
3. **"Users"** 탭 → **"사용자 추가"** → 팀에서 공용으로 쓸 이메일/비밀번호 입력 후 저장
   - 이 계정이 곧 대시보드 로그인 계정입니다. 팀원들에게 이 이메일/비밀번호를 공유하면 됩니다.
   - 필요하면 팀원별로 계정을 추가로 만들어도 됩니다 (Users 탭에서 "사용자 추가"를 반복).

### 1-4. 웹 앱 등록 & 설정값 복사
1. 프로젝트 설정(⚙️ 아이콘) > **"프로젝트 설정"** 클릭
2. 아래로 스크롤 → **"내 앱"** → `</>` (웹 앱 추가) 아이콘 클릭
3. 앱 닉네임 입력 (예: `team-dashboard-web`) → Firebase 호스팅은 체크하지 않아도 됨 → 앱 등록
4. 화면에 나오는 `firebaseConfig` 객체 값을 복사합니다. 예:

```js
const firebaseConfig = {
  apiKey: "AIzaSy....",
  authDomain: "seegene-team-dashboard-xxxx.firebaseapp.com",
  projectId: "seegene-team-dashboard-xxxx",
  storageBucket: "seegene-team-dashboard-xxxx.appspot.com",
  messagingSenderId: "1234567890",
  appId: "1:1234567890:web:abcdef123456"
};
```

5. 이 프로젝트 폴더의 **`firebase-config.js`** 파일을 열어 `YOUR_API_KEY` 등 자리표시자 값을
   위에서 복사한 실제 값으로 교체 후 저장합니다. (이 값은 비밀키가 아니라 앱 식별용 공개 설정이라
   GitHub에 그대로 올려도 안전합니다 — 실제 보호는 1-2단계의 보안 규칙과 1-3단계의 로그인이 담당합니다.)

---

## 2단계. GitHub 저장소 만들고 GitHub Pages로 배포

1. https://github.com 에서 계정이 없다면 무료로 가입
2. 우측 상단 **"+" > "New repository"** → 저장소 이름 입력 (예: `team-dashboard`) →
   **Public**으로 설정(GitHub Pages 무료 사용을 위해 Public 권장) → **Create repository**
3. 저장소 페이지에서 **"uploading an existing file"** 링크 클릭 (또는 "Add file > Upload files")
4. 이 폴더 안의 파일들을 전부 드래그해서 업로드:
   - `index.html`
   - `style.css`
   - `app.js`
   - `firebase-config.js` (실제 값으로 수정한 버전)
   - (참고용) `firestore.rules`, `README.md`
5. 하단에 커밋 메시지 입력 후 **"Commit changes"**

### 2-1. GitHub Pages 활성화
1. 저장소 상단 메뉴 **Settings > Pages** 이동
2. **"Build and deployment"** 의 Source를 **"Deploy from a branch"**로 선택
3. Branch를 `main` (또는 `master`), 폴더는 `/ (root)` 선택 후 **Save**
4. 1~2분 후 같은 화면 상단에 `https://<본인계정>.github.io/team-dashboard/` 형태의 주소가 생성됩니다.

### 2-2. Firebase에 배포 주소 등록 (승인된 도메인)
GitHub Pages 주소가 Firebase 로그인에서 차단되지 않도록 등록해야 합니다.
1. Firebase 콘솔 > Authentication > **Settings** 탭 > **"승인된 도메인(Authorized domains)"**
2. **"도메인 추가"** → `<본인계정>.github.io` 입력 후 추가

---

## 3단계. 접속 & 사용

1. 크롬에서 `https://<본인계정>.github.io/team-dashboard/` 접속
2. 1-3단계에서 만든 이메일/비밀번호로 로그인
3. **주간보고 탭** → 영업기획팀 / 영업관리팀 중 팀 선택
4. 화면은 3단 컬럼으로 구성됩니다: 왼쪽 **프로젝트** 열 → 가운데 **카테고리** 열 → 오른쪽
   **상세내용** 열. 왼쪽 열에서 **+ 추가**로 1차 레이어(예: GMCS project)를 만들고 그 행을
   클릭해 선택하면, 가운데 열에서 **+ 추가**로 2차 레이어(예: 기획, 대시보드)를 만들 수
   있습니다. 가운데 열에서 카테고리를 클릭해 선택하면 오른쪽 열에 그 주의 상세내용이
   나타나고, **+ 상세내용 추가**로 새 내용을 기재합니다.
5. 상단 주차 이동(‹ ›)으로 지난 주 기록도 확인할 수 있습니다. 프로젝트/카테고리 구조는 주차와
   무관하게 유지되고, 상세내용만 선택한 주차 기준으로 표시됩니다.
6. 내용이 전주와 크게 다르지 않을 때는, 오른쪽 상세내용 열 상단의 **"◀ 지난 주 내용
   가져오기"** 버튼으로 직전 주에 그 카테고리에 적었던 내용을 이번 주로 복사해온 뒤
   필요한 부분만 수정하면 됩니다. (카테고리별로 실행하며, 원본은 그대로 두고 복사본이
   새로 추가되는 방식입니다.)

여러 기기(사무실 PC, 집, 휴대폰 크롬 등)에서 같은 주소로 로그인하면 Firestore를 통해
실시간으로 같은 데이터가 동기화됩니다.

---

## 이후 내용을 수정하고 싶을 때

GitHub 저장소의 **"Add file > Upload files"**로 수정한 파일을 다시 올리고 커밋하면
1~2분 내로 같은 주소에 자동 반영됩니다. (Git을 쓸 줄 안다면 `git clone` 후 수정 → `git push`도 가능합니다.)
다음 탭("성과관리" 등)을 추가할 때도 이 파일들을 이어서 확장하면 됩니다.

## 참고 / 주의사항

- Firebase 무료(Spark) 플랜은 읽기/쓰기 횟수와 저장 용량에 여유로운 무료 한도가 있어 팀 내부용
  사용량으로는 사실상 비용이 발생하지 않습니다.
- 로그인 계정의 이메일/비밀번호는 곧 데이터에 대한 접근권한이므로 팀 내에서만 안전하게 공유하세요.
- 별도 자동 백업은 없으므로, 중요한 내용은 주기적으로 Firebase 콘솔의 Firestore 데이터를
  확인하거나 내보내기(Export)하는 것을 권장합니다.

## 막히면

- 로그인 후 화면에 "⚠ 연결 오류" 또는 "Firestore 연결에 실패했습니다"가 뜨면 → `firebase-config.js`
  값이 정확한지, 1-2단계 보안 규칙이 게시되었는지 확인하세요.
- 로그인 자체가 "이메일 또는 비밀번호를 확인하세요" 오류로 실패하면 → 1-3단계에서 이메일/비밀번호
  로그인 방식을 켰는지, 사용자 계정을 만들었는지 확인하세요.
- GitHub Pages 주소에서 로그인이 계속 실패하면 → 2-2단계의 승인된 도메인에 `.github.io` 주소를
  등록했는지 확인하세요.
