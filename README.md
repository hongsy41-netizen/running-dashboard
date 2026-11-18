# 🏃 서율아빠의 러닝 대시보드

Strava 기록을 한 장의 페이지로 보는 개인 러닝 대시보드입니다.
빌드 도구 없이 정적 파일(HTML/CSS/JS)만으로 동작하고, 데이터는 저장소 안의
`data/*.json`을 브라우저가 그대로 읽어 그립니다.

- 라이브: https://hongsy41-netizen.github.io/running-dashboard/
- 데이터: Strava 전체 기록 내보내기(archive) — 러닝 1,276개 (2019.04 ~ 2026.11), 누적 12,760.7km / 1,233시간
- 지도: 그중 1,190개(93%)는 기기 FIT/GPX에서 뽑은 실제 GPS 트랙, 나머지는 실내 러닝이라 좌표 없음

## 화면에 담긴 것

| 영역 | 내용 |
| --- | --- |
| 핵심 지표 | 누적 거리·러닝 횟수·총 시간·평균 페이스·최장 거리·올해/이번 달 |
| 목표 달성률 | 올해(기본 3,000km)·이번 주(월~일, 기본 60km) 진행률. 숫자를 눌러 목표를 바꾸면 `localStorage`에 저장 |
| 거리별 PR | 5K·10K·하프·풀 구간 최고 평균 페이스와 표준 거리 환산 시간, 카드 클릭 시 활동 상세 모달 |
| 전체 코스 지도 | 연도별 GPS 경로를 한 장에 겹쳐 보기(전체 1,190개 / 연도별). 겹칠수록 진하게, 코스 수·합계 거리 요약 |
| 러닝 히트맵 | 연도별 잔디형 달력, 하루 거리에 따른 5단계 색, 날짜 툴팁 |
| 월별 추이 | 월별 거리(막대) + 평균 페이스(선) 이중 축 |
| 연도별 추이 | 연간 거리 + 그 해 평균 페이스 |
| 심박·유산소 효율 | 연도를 골라 월별 평균 심박(bpm)과 심박 효율(m/beat) 추이. 심박 기록 없는 활동은 제외 |
| 패턴 | 요일별 거리, 시간대별 러닝 횟수 |
| 개인 기록 | 최장 거리·최장 시간·최고 평균 페이스(5km 이상)·최다 월간/주간·최장 연속일 |
| 활동 목록 | 연도 필터 + 이름 검색 + 거리 구간(10km+/하프/풀) + 정렬(최신/최장/빠른 페이스) + 더 보기, 클릭하면 상세 모달 |
| 상세 모달 | GPS 경로 지도(Leaflet), 거리·시간·페이스·고도·심박·케이던스·칼로리·메모 |

GPS 좌표가 없는 실내(트레드밀) 러닝은 지도 대신 안내 문구를 보여 줍니다.

## 폴더 구조

```
index.html               화면
assets/style.css         라이트 테마 스타일
assets/app.js            데이터 로딩·차트·히트맵·목록·모달
data/activities.json     활동 요약 (러닝만)
data/polylines/<연도>.json   활동 id → 인코딩 polyline (지도용, 연도별로 지연 로딩)
scripts/build_data.py    아카이브 CSV + polyline → data/*.json
scripts/stream_archive.py 2.6GB 아카이브 zip을 저장하지 않고 스트리밍으로 필요한 것만 추출
scripts/sync_strava.py   주기 동기화(공식 API 또는 웹 세션 쿠키)
.github/workflows/deploy.yml  main 푸시 시 GitHub Pages 배포
.github/workflows/sync.yml    매일 07:20 KST 동기화(시크릿 있을 때만)
```

## 데이터 갱신 방법

### 1) 전체 재수집 (가장 확실함 · 몇 달에 한 번)

1. Strava → 설정 → 내 계정 → **Download or Delete Your Account** → *Request Your Archive*
2. 메일로 온 링크에서 `export_*.zip` 다운로드 (2GB 안팎)
3. 스트리밍으로 필요한 부분만 뽑기 — zip을 풀어 저장할 필요가 없습니다.

```bash
curl -sS "https://s3.amazonaws.com/.../export_XXXX.zip?..." \
  | python3 scripts/stream_archive.py archive_out raw/polylines_raw.json
python3 scripts/build_data.py archive_out/activities.csv raw/polylines_raw.json data
git add data && git commit -m "chore: 데이터 갱신" && git push
```

`stream_archive.py`는 표준 라이브러리만 사용하며, `.fit.gz` 안의 GPS 트랙을
디코딩해 800점 이하로 단순화한 polyline으로 바꿔 둡니다.

### 2) 매일 자동 동기화 — 공식 API (유료 계정일 때)

저장소 Settings → Secrets and variables → Actions 에 아래 3개를 넣으면
`sync.yml`이 자동으로 최신 기록만 덧붙입니다.

- `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET`, `STRAVA_REFRESH_TOKEN`

> Strava는 2026년 7월부터 **무료 계정의 API 호출을 제한**합니다. 현재 계정이
> Free라서 이 경로는 구독 전환 전까지 403이 돌아옵니다.

### 3) 매일 자동 동기화 — 웹 세션 쿠키

`STRAVA_COOKIE` 시크릿에 브라우저 개발자도구(Application → Cookies →
`https://www.strava.com`)의 `_strava4_session=...` 값을 넣으면 웹 트레이닝 로그
엔드포인트로 20개씩 넘겨 읽습니다.

- 쿠키는 수 주~수 개월마다 만료됩니다. 만료되면 동기화가 조용히 실패하므로
  GitHub Actions 로그를 가끔 확인하세요.
- 이 방식은 Strava 웹이 쓰는 비공식 엔드포인트라 예고 없이 바뀔 수 있습니다.

## 보안

- 쿠키·토큰·클라이언트 시크릿은 **코드에 넣지 않습니다**. 오직 GitHub Actions
  시크릿(또는 로컬 환경변수)으로만 읽습니다.
- `data/`에는 공개해도 되는 활동 요약(거리·시간·심박 등)만 들어 있습니다.
  계정 비밀번호, 세션 쿠키, 위치 원본 파일은 저장소에 없습니다.
- 아카이브에서 뽑은 중간 산출물(`archive_out/`, `raw/`, `*.zip`)은 `.gitignore`로
  제외합니다.

## 참고한 오픈소스

- [yihong0618/running_page](https://github.com/yihong0618/running_page) — 히트맵·연간 통계 구성
- [aspain/git-sweaty](https://github.com/aspain/git-sweaty) — GitHub 잔디 스타일 시각화
- [Daniel-Wong94/GitFit](https://github.com/Daniel-Wong94/GitFit) — 활동 목록·요약 카드 구성
