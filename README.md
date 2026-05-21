# KTST Task Matrix · Live

KTST to-do 데이터베이스를 **긴급도 × 중요도** 좌표평면(쌀알 산점도)으로 실시간 시각화하는 미니 웹앱입니다.

- 프론트엔드: `public/index.html` (Vanilla SVG/JS)
- 백엔드: `api/tasks.js` (Vercel Serverless Function이 Notion API 호출)
- 배포: Vercel (무료)

---

## 1. Notion Integration 토큰 발급

1. https://www.notion.so/profile/integrations 접속
2. **New integration** → 이름 입력 (예: `KTST Task Matrix`), Workspace 선택 → **Save**
3. **Internal Integration Secret** 값을 복사 (`secret_` 또는 `ntn_`로 시작)
4. 발급받은 토큰을 안전한 곳에 보관 — 깃허브에 절대 커밋 금지

## 2. Integration을 KTST to-do DB에 연결

1. Notion에서 **🎒 KTST to-do** 데이터베이스 페이지 열기
2. 우측 상단 **⋯** (More) → **Connections** → **Connect to** → 위에서 만든 Integration 선택
3. "Confirm" 클릭 → Integration이 이 DB에 접근 가능해집니다

## 3. Database ID 확인

KTST to-do 페이지를 브라우저에서 열고 URL을 확인하세요:

```
https://www.notion.so/<your-workspace>/<view-name>-16764f0430d94d46b57fa4c768eea4fc?v=...
                                 └──────── Database ID ────────┘
```

현재 워크스페이스 기준 KTST to-do의 ID는 **`16764f04-30d9-4d46-b57f-a4c768eea4fc`** 입니다 (`.env.example`에 이미 기재).

## 4. 로컬 테스트 (선택)

```bash
npm install -g vercel
cp .env.example .env.local
# .env.local 에 실제 NOTION_TOKEN 채우기
vercel dev
# → http://localhost:3000 접속
```

## 5. Vercel 배포

### 옵션 A — Vercel CLI (가장 빠름)

```bash
npm install -g vercel
cd ktst-task-matrix-live
vercel
# 안내에 따라 프로젝트 이름 입력. 첫 배포 후:
vercel env add NOTION_TOKEN          # Production 선택 후 토큰 붙여넣기
vercel env add NOTION_DATABASE_ID    # Production 선택 후 DB ID 붙여넣기
vercel --prod
```

### 옵션 B — GitHub + Vercel 대시보드

1. 이 폴더를 GitHub 새 repo로 push (**`.env*` 파일은 절대 push하지 말 것**)
2. https://vercel.com/new → repo Import
3. **Environment Variables** 섹션에 추가:
   - `NOTION_TOKEN` = 발급받은 secret
   - `NOTION_DATABASE_ID` = `16764f04-30d9-4d46-b57f-a4c768eea4fc`
4. **Deploy** 클릭

## 6. Notion 페이지에 임베드

배포 완료 후 받은 URL (예: `https://ktst-task-matrix.vercel.app`)을

1. Notion 페이지에서 `/embed` 입력
2. URL 붙여넣기 → **Embed link** 선택
3. 크기 조절

끝. 페이지 새로고침할 때마다 Notion DB의 최신 상태가 반영됩니다 (60초 캐시).

---

## 동작 원리

- `/api/tasks` 호출 → Vercel Serverless가 Notion API `POST /v1/databases/{id}/query` 요청
- `Status != Completed` 필터 적용, 페이지네이션 자동 처리
- 응답을 가공해 `{id, name, status, priority, due, assignees, url}` 형태로 반환
- 60초 edge cache (Cache-Control: `s-maxage=60, stale-while-revalidate=300`)
- 프론트엔드는 응답을 받아 SVG 산점도 + 표로 그림

## 좌표 계산 규칙

- **X축 (긴급도)**: `Due Date`까지 남은 일수
  - 30일 이상 → 0.05 (거의 왼쪽 끝)
  - 0일 (오늘/지남) → 1.0 (오른쪽 끝)
  - Due Date 없음 → 0.15
- **Y축 (중요도)**: `Priority` Select 값에서 숫자 추출 (1~5)
  - `"5 (High)"` → 5 → 위쪽
  - `"1 (Low)"` → 1 → 아래쪽

같은 좌표에 여러 task가 모이면 원형으로 자동 흩어뜨림(jitter)

## 보안 메모

- **토큰을 클라이언트(public 폴더, index.html 등)에 절대 넣지 마세요.** 항상 Serverless 함수의 환경변수로만.
- `/api/tasks`는 현재 공개입니다. 인증을 추가하려면 함수 상단에 헤더 체크 로직 추가:

  ```js
  if (req.headers["x-api-key"] !== process.env.MY_KEY) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  ```

## 커스터마이징 포인트

- 색상: `public/index.html`의 `PRIORITY_COLORS`
- 긴급도 horizon: `URGENCY_HORIZON_DAYS` (기본 30일)
- 사분면 배경색: `drawChartFrame()`의 `quadColors`
- 필터 변경: `api/tasks.js`의 `body.filter`
- 표시할 속성 추가: `api/tasks.js`에서 더 많은 필드를 읽어 응답에 포함
