# sync-api 자체 호스팅 가이드

Dolgate의 브라우저 로그인과 데이터 동기화를 직접 운영하려면 `sync-api`를 별도 서버에 띄우면 됩니다.
이 문서는 가장 단순한 SQLite 단일 인스턴스 배포부터 MySQL, OIDC, 운영 시 주의사항까지 한 번에 정리한 가이드입니다.

## 가장 빠른 시작: SQLite 단일 인스턴스

`docker-compose.yml`을 아래 내용으로 만들고 띄웁니다.

```yaml
services:
  sync-api:
    image: ghcr.io/doldolma/dolgate-sync-api:latest
    container_name: dolgate-sync-api
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - dolgate-sync-api-data:/app/data

volumes:
  dolgate-sync-api-data:
```

```bash
docker compose up -d
docker compose ps
curl http://127.0.0.1:8080/healthz
```

- `/app/data`에 SQLite DB와 인증 서명 키(첫 부팅 시 자동 생성)가 저장됩니다.
- 이 volume을 잃으면 토큰·세션이 모두 무효화되어 전원 재로그인이 필요합니다.

## 데스크톱 앱 연결

서버가 뜨면 데스크톱 앱에서 다음 순서로 연결합니다.

1. 로그인 화면에서 톱니바퀴를 엽니다.
2. `Login Server`를 self-host 주소로 바꿉니다.
3. 저장 후 로그인/동기화를 진행합니다.

예:

- 로컬 테스트: `http://127.0.0.1:8080`
- reverse proxy 뒤 운영: `https://ssh.example.com`

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./login-dark.png">
  <img alt="Login Server 설정 화면" src="./login.png">
</picture>

## 운영 기본값과 권장 설정

### 이미지 태그

- 예제는 빠른 시작용으로 `latest`를 사용합니다.
- 운영에서는 버전 태그 pinning을 권장합니다.

예:

```yaml
image: ghcr.io/doldolma/dolgate-sync-api:X.Y.Z
```

업데이트 절차:

```bash
docker compose pull
docker compose up -d
```

### 백업 대상

SQLite 단일 인스턴스 기준으로는 `/app/data` 전체를 백업하면 됩니다.

중요 파일:

- `dolgate_sync.db`
- `auth-signing-private.pem`

### HTTPS / reverse proxy

- 운영 배포는 HTTPS reverse proxy 뒤에 두는 것을 전제로 하는 편이 안전합니다.
- reverse proxy를 쓴다면 `TRUSTED_PROXIES`에 실제 프록시 주소만 넣어야 합니다.
- `TRUSTED_PROXIES`를 비워 두면 `X-Forwarded-For`를 신뢰하지 않습니다.

예:

```yaml
environment:
  TRUSTED_PROXIES: "172.17.0.1,10.0.0.0/8"
```

현재 repo에는 nginx 예제 파일이 포함되어 있지 않으므로, 사용하는 프록시에 맞춰 `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` 전달을 맞추고 **WebSocket 업그레이드(`Upgrade`/`Connection` 헤더)를 허용**해야 합니다. 일부 기능이 WebSocket을 사용하므로 막히면 동작하지 않습니다.

## MySQL + Google OIDC

SQLite 대신 MySQL을 쓰고, 로컬 로그인·회원가입을 끄고 Google OIDC만 허용하는 구성입니다. DB는 이미 운영 중인 MySQL을 가리킵니다.

```yaml
services:
  sync-api:
    image: ghcr.io/doldolma/dolgate-sync-api:latest
    container_name: dolgate-sync-api
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      DB_DRIVER: mysql
      DATABASE_URL: dolgate_user:CHANGE_ME_PASSWORD@tcp(172.17.0.1:3309)/dolgate?charset=utf8mb4&parseTime=True&loc=UTC
      LOCAL_AUTH_ENABLED: "false"
      LOCAL_SIGNUP_ENABLED: "false"
      OIDC_ENABLED: "true"
      OIDC_DISPLAY_NAME: "Google"
      OIDC_ISSUER_URL: "https://accounts.google.com"
      OIDC_CLIENT_ID: "CHANGE_ME_CLIENT_ID"
      OIDC_CLIENT_SECRET: "CHANGE_ME_CLIENT_SECRET"
      OIDC_REDIRECT_URL: "https://ssh.example.com/auth/oidc/callback"
      OIDC_SCOPES: "openid,profile,email"
      TRUSTED_PROXIES: "172.17.0.1"
    volumes:
      - dolgate-sync-api-data:/app/data

volumes:
  dolgate-sync-api-data:
```

주의사항:

- 비밀번호는 예제의 `CHANGE_ME_*` 값을 그대로 쓰면 안 됩니다.
- DB를 MySQL로 옮겨도 signing key는 계속 필요하므로 `sync-api`의 `/app/data` volume은 유지하세요.

OIDC 입력값

- `OIDC_ISSUER_URL`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`
- `OIDC_REDIRECT_URL`
- `OIDC_SCOPES`

`OIDC_REDIRECT_URL`은 실제 외부에서 접근하는 주소와 정확히 일치해야 합니다.

## 패스키(WebAuthn) 로그인

브라우저 로그인에 패스키를 추가로 켤 수 있습니다(비밀번호·OIDC와 공존).

- `WEBAUTHN_ENABLED: "true"`로 켭니다. 단 `PUBLIC_BASE_URL`이 **HTTPS 도메인**이어야 합니다(IP·평문 HTTP 불가, `localhost`만 개발용 예외). 조건이 안 맞으면 부팅 시 자동 비활성화됩니다.
- RP 값은 `PUBLIC_BASE_URL`에서 자동 유도되며, 필요하면 `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_DISPLAY_NAME` / `WEBAUTHN_ORIGINS`로 직접 지정합니다.
- 패스키는 등록한 도메인에 묶이므로 도메인이 바뀌면 재등록이 필요합니다.

## 설정 파일로 운영하기

환경 변수 대신 JSON 설정 파일로도 운영할 수 있습니다. 항목이 많아지는 OIDC·패스키 구성이나, 설정을 버전 관리하고 싶을 때 편합니다.

`sync-api`는 다음 경로를 순서대로 찾아 **처음 발견한 설정 파일을 자동으로 읽습니다.**

```text
./config.json
./config/config.json
/etc/dolgate/config.json
```

- 상대 경로는 작업 디렉터리 기준입니다. 컨테이너 이미지의 작업 디렉터리가 `/app`이라 `/app/config.json` 또는 `/app/config/config.json`으로 마운트하면 그대로 잡힙니다.
- 다른 위치를 쓰려면 `DOLSSH_API_CONFIG_PATH`로 경로를 직접 지정합니다(지정하면 자동 탐색은 건너뜁니다).
- **환경 변수는 파일 값을 덮어씁니다**(파일 → env 순서로 적용). 비밀 값만 환경 변수로 빼서 섞어 쓸 수 있습니다.

```json
{
  "server": {
    "port": "8080",
    "trustedProxies": ["172.17.0.1"],
    "publicBaseUrl": "https://ssh.example.com"
  },
  "database": {
    "driver": "mysql",
    "url": "dolgate_user:CHANGE_ME_PASSWORD@tcp(mysql:3306)/dolgate?charset=utf8mb4&parseTime=True&loc=UTC"
  },
  "auth": {
    "signingPrivateKeyPath": "./data/auth-signing-private.pem",
    "accessTokenTtlMinutes": 15,
    "refreshTokenIdleDays": 14,
    "offlineLeaseTtlHours": 72,
    "local": {
      "enabled": false,
      "signupEnabled": false
    },
    "oidc": {
      "enabled": true,
      "displayName": "Google",
      "issuerUrl": "https://accounts.google.com",
      "clientId": "CHANGE_ME_CLIENT_ID",
      "clientSecret": "CHANGE_ME_CLIENT_SECRET",
      "redirectUrl": "https://ssh.example.com/auth/oidc/callback",
      "scopes": ["openid", "profile", "email"]
    },
    "webauthn": {
      "enabled": true
    }
  }
}
```

컨테이너에 마운트해서 쓰는 예입니다.

```yaml
services:
  sync-api:
    image: ghcr.io/doldolma/dolgate-sync-api:latest
    container_name: dolgate-sync-api
    restart: unless-stopped
    ports:
      - "8080:8080"
    volumes:
      - ./config.json:/app/config/config.json:ro
      - dolgate-sync-api-data:/app/data

volumes:
  dolgate-sync-api-data:
```

- 적지 않은 항목은 기본값을 씁니다(아래 [기본값 메모](#자주-쓰는-환경-변수) 참고).
- 비밀 값(`clientSecret`, DB 비밀번호, `signingPrivateKeyPem`)이 파일에 들어가므로 권한을 좁히고 저장소에 커밋하지 마세요.
- 부팅 로그에 어떤 설정을 읽었는지 찍히므로 적용 여부를 확인할 수 있습니다.

## 자주 쓰는 환경 변수

`sync-api`는 설정 파일 없이 환경 변수만으로도 운영할 수 있습니다(설정 파일과 섞어 쓰면 환경 변수가 우선합니다 — 위 [설정 파일로 운영하기](#설정-파일로-운영하기) 참고).

주요 변수:

```text
PORT
DB_DRIVER
DATABASE_URL
TRUSTED_PROXIES
PUBLIC_BASE_URL
AUTH_SIGNING_PRIVATE_KEY_PEM
AUTH_SIGNING_PRIVATE_KEY_PATH
ACCESS_TOKEN_TTL_MINUTES
REFRESH_TOKEN_IDLE_DAYS
OFFLINE_LEASE_TTL_HOURS
REFRESH_ROTATION_HANDOFF_SECONDS
LOCAL_AUTH_ENABLED
LOCAL_SIGNUP_ENABLED
OIDC_ENABLED
OIDC_DISPLAY_NAME
OIDC_ISSUER_URL
OIDC_CLIENT_ID
OIDC_CLIENT_SECRET
OIDC_REDIRECT_URL
OIDC_SCOPES
WEBAUTHN_ENABLED
WEBAUTHN_RP_ID
WEBAUTHN_RP_DISPLAY_NAME
WEBAUTHN_ORIGINS
```

기본값 메모:

- `PORT`: `8080`
- `DB_DRIVER`: `sqlite` (`mysql`, `postgres`도 지원)
- `DATABASE_URL`: `file:./data/dolgate_sync.db?_pragma=busy_timeout(5000)`
- `AUTH_SIGNING_PRIVATE_KEY_PATH`: `./data/auth-signing-private.pem`
- `LOCAL_AUTH_ENABLED`: `true`
- `LOCAL_SIGNUP_ENABLED`: `true`
- `OIDC_ENABLED`: `false`
- `WEBAUTHN_ENABLED`: `false` (활성화하려면 `PUBLIC_BASE_URL`이 HTTPS 도메인이어야 함 — 위 패스키 섹션 참고)

PostgreSQL을 사용할 때는 `DB_DRIVER=postgres`와 PostgreSQL DSN을 지정합니다.

```text
DATABASE_URL=host=127.0.0.1 user=dolgate_user password=CHANGE_ME_PASSWORD dbname=dolgate port=5432 sslmode=disable TimeZone=UTC
```

## 서명 키 관련 주의사항

`sync-api`는 access token, browser login state, offline lease를 모두 같은 RS256 signing keypair로 서명합니다.

운영 팁:

- 단일 인스턴스면 `/app/data/auth-signing-private.pem` 자동 생성만으로도 충분합니다.
- 멀티 인스턴스 운영이나 키 교체 정책이 필요하면 직접 PEM을 주입해야 합니다.
- 별도 PEM을 주입하면 자동 생성보다 그 값을 우선 사용합니다.

지원 방식:

- `AUTH_SIGNING_PRIVATE_KEY_PEM`
- `AUTH_SIGNING_PRIVATE_KEY_PATH`


## 관련 문서

- [빌드 및 배포](./build-and-deploy.md)
- [아키텍처](./architecture.md)
