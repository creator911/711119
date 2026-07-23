# 출장나라 10만 회원 확장 전환 절차

이 문서는 대문·진입 페이지를 변경하지 않고 메인 서비스와 관리자 서비스만
확장 구조로 전환하는 운영 절차다. 현재 SQLite 운영 모드는 새 환경 변수를
설정하기 전까지 그대로 유지된다.

## 목표 구성

- Cloudflare → Vultr Load Balancer → 동일 공개 앱 서버 2대
- 관리자 앱 1개 독립 프로세스/풀, 작업 서버 1개 독립 프로세스/풀
- 관리형 PostgreSQL(자동 장애조치/PITR) → PgBouncer → 역할별 연결 문자열
- 관리형 Valkey: 세션 단기 캐시, 조회수 버퍼, 분산 잠금
- Cloudflare R2: 사용자 미디어, 브라우저 서명 URL 직접 업로드
- 공개·관리자 호스트별 Cloudflare WAF/Access/쿠키/원본 정책 분리

공개 앱 두 대의 `/api/health`를 로드밸런서 상태 검사로 사용한다. 관리자
상태 표시는 DB뿐 아니라 Valkey, R2, 작업 서버 heartbeat, 필수 스키마를
함께 검사한다.

## 인프라 생성 후 비밀 설정

유료 리소스 생성과 DNS 변경은 운영자 승인 후 수행한다. 각 앱 서버에는
`shared.env.example`과 `public.env.example`, 관리자 서버에는
`shared.env.example`과 `admin.env.example`, 작업 서버에는
`shared.env.example`과 `worker.env.example`을 각각 `/etc/nara001`에
root:nara001, `0640`으로 설치한다.

공개·관리자·작업 서버는 서로 다른 PostgreSQL 계정을 사용한다.

```sh
MIGRATION_DATABASE_URL='postgresql://migration-owner:...@primary:5432/defaultdb' \
POSTGRES_PUBLIC_PASSWORD='...' \
POSTGRES_ADMIN_PASSWORD='...' \
POSTGRES_WORKER_PASSWORD='...' \
npm run db:roles:postgres
```

R2 CORS는 실제 공개 도메인만 허용한 뒤 서명 업로드를 켠다.

```sh
R2_ALLOWED_ORIGINS='https://www.nara001.co.kr,https://nara001.co.kr' \
node deploy/configure-r2-cors.mjs
```

## 이전 연습(반드시 두 번)

1. 운영 SQLite와 미디어의 암호화 스냅샷을 스테이징에 복원한다.
2. 10만 회원/수백만 활동 데이터가 필요하면 운영 복사본 대신
   `LOAD_SEED_CONFIRM` 보호가 적용된 `npm run load:seed`로 별도 fixture를 만든다.
3. 비어 있는 PostgreSQL 스키마에 `npm run db:copy:postgres`를 실행한다.
   도구는 SQLite를 잠가 일관된 스냅샷을 읽고, 모든 테이블 수와 COPY
   체크섬을 보고서에 기록하며, 제약·인덱스·트리거를 만든 뒤 검증한다.
4. `npm run media:copy:r2`로 차분 복사하고 개수·크기·해시 보고서를 보관한다.
5. 자동 테스트·빌드·동시성 시험을 두 번 실행한다.
6. 공개 앱 2대, 관리자 앱, 작업 서버를 스테이징 주소에서 구동한다.
7. 10,000 VU 60분과 20,000 VU 5분은 승인된 스테이징 주소에만 실행한다.

```sh
LOAD_TEST_TARGET='https://staging.example.com' \
LOAD_TEST_CONFIRM='staging.example.com' \
LOAD_TEST_FULL_SCALE=1 npm run load:k6

# 동시 쓰기는 폐기 가능한 전용 스테이징 계정으로만 별도 실행한다.
LOAD_TEST_TARGET='https://staging.example.com' \
LOAD_TEST_CONFIRM='staging.example.com' \
LOAD_TEST_SESSION_COOKIE='staging-session-token' \
LOAD_TEST_USERS=0 LOAD_TEST_SPIKE_USERS=0 \
LOAD_TEST_WRITE_USERS=500 LOAD_TEST_WRITE_DURATION='5m' npm run load:k6

# 시험 직후 중복 지급·중복 투표·음수 재고·일일 횟수 위반을 대조한다.
MIGRATION_DATABASE_URL='postgresql://read-audit:...@primary:5432/defaultdb' \
npm run load:verify
```

## 본 전환

1. 48시간 전 기능 변경을 중단하고 검증된 release SHA를 고정한다.
2. 점검 시작 후 공개 쓰기를 차단하고 앱·작업 서버를 정지한다.
3. SQLite WAL 체크포인트와 DB/미디어 최종 암호화 스냅샷을 만든다.
4. 최종 `db:copy:postgres`, R2 차분 복사를 실행한다.
5. 회원/게시글/댓글/포인트 원장/재고/지급 이미지/오너 계정을 보고서로 대조한다.
6. 관리자·작업 서버를 먼저 올리고 heartbeat와 관리자 상태를 확인한다.
7. 공개 앱을 한 대씩 올려 `/api/health`를 확인한 뒤 LB에 편입한다.
8. Cloudflare 캐시/WAF와 공개 도메인을 연다.
9. 기존 DB와 미디어는 암호화된 읽기 전용 상태로 7일 보관한다.

DB 변경은 이후에도 `확장 → 양쪽 호환 확인 → 코드 전환 → 구 구조 정리`
순서로만 진행한다. 앱 release는 한 대씩 교체하며, 둘 다 정상일 때만 이전
release를 정리한다.

## 관리자 도메인 분리

현재 공개 도메인의 `/admin`과 `/api/admin`은 nginx가 독립 관리자
프로세스(3100)로 전달한다. 별도 관리자 도메인 준비 후
`nginx-split.conf.template`의 관리자 호스트 값과 `ADMIN_ALLOWED_HOSTS`만
변경한다. 관리자 쿠키와 비밀키는 공개 회원 세션과 분리되어 있다.

관리자 호스트에는 Cloudflare Access, 별도 WAF, 허용 국가/IP 또는 장치
정책을 적용하고 검색엔진 차단 헤더를 유지한다. 검증이 끝난 뒤에만 공개
도메인의 임시 `/admin` 전달 규칙을 제거한다.

## 장애 및 보관 시험

- 앱 서버 한 대 중단: LB에서 제외되고 공개 요청이 계속 성공해야 한다.
- 작업 서버 중단: 사용자 쓰기는 성공하고 outbox가 쌓인 뒤 재시작 시 처리된다.
- Valkey 중단: 핵심 DB 원장은 유지되며 관리자 상태는 degraded가 된다.
- PostgreSQL 장애조치: PgBouncer/관리형 endpoint 재연결 후 중복 지급이 없어야 한다.
- R2 지연: 업로드는 실패 안내 후 재시도 가능하고 게시글 원장은 오염되지 않아야 한다.
- 삭제 게시글·연결 해제 미디어 7일, nginx 접근/오류 및 로그인 보안 기록 30일을 유지한다.
- 포인트·구매·상품 지급·이벤트 정산 원장은 삭제 작업 대상에 포함하지 않는다.

CPU 60%, DB 연결 70%, Valkey 메모리 70%가 10분 이상 지속되거나 읽기
P95 0.5초/쓰기 P95 1.5초를 넘으면 앱 수평 증설 또는 관리형 인스턴스
확장을 시작한다.
