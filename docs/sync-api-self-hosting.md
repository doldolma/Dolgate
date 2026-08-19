# Self-hosting sync-api

To run Dolgate's browser login and data sync on your own infrastructure, deploy `sync-api` on a server of your choice.
This guide covers everything in one place — from the simplest single-instance SQLite deployment to MySQL, OIDC, and operational notes.

## Fastest start: single instance with SQLite

Create a `docker-compose.yml` with the following content and bring it up.

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

- `/app/data` holds the SQLite database and the auth signing key (generated automatically on first boot).
- If you lose this volume, every token and session is invalidated and all users must sign in again.

## Connecting the desktop app

Once the server is up, connect the desktop app in this order:

1. Click the gear icon on the login screen.
2. Change `Login Server` to your self-hosted address.
3. Save, then proceed with login/sync.

Examples:

- Local testing: `http://127.0.0.1:8080`
- Behind a reverse proxy: `https://ssh.example.com`

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="./images/login-dark.png">
  <img alt="Login Server settings screen" src="./images/login.png">
</picture>

## Operational defaults and recommendations

### Image tags

- The examples use `latest` for a quick start.
- For production, pin a version tag.

Example:

```yaml
image: ghcr.io/doldolma/dolgate-sync-api:X.Y.Z
```

Update procedure:

```bash
docker compose pull
docker compose up -d
```

### What to back up

For a single-instance SQLite deployment, backing up all of `/app/data` is enough.

Important files:

- `dolgate_sync.db`
- `auth-signing-private.pem`

SQLite runs in WAL mode, so recent commits may still live in `dolgate_sync.db-wal` next to the
database file. Copying only `dolgate_sync.db` from a running server can therefore miss the newest
data. Either back up the whole `/app/data` directory with the server stopped, or take a consistent
copy while it runs:

```bash
docker compose exec sync-api sqlite3 /app/data/dolgate_sync.db ".backup '/app/data/backup.db'"
```

### HTTPS / reverse proxy

- Production deployments should sit behind an HTTPS reverse proxy.
- If you use a reverse proxy, put only the actual proxy addresses in `TRUSTED_PROXIES`.
- With `TRUSTED_PROXIES` left empty, `X-Forwarded-For` is not trusted.

Example:

```yaml
environment:
  TRUSTED_PROXIES: "172.17.0.1,10.0.0.0/8"
```

The repository does not ship an nginx example, so configure your proxy to forward `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`, and make sure it **allows WebSocket upgrades (`Upgrade`/`Connection` headers)**. Some features run over WebSocket and will not work if it is blocked.

## MySQL + Google OIDC

This configuration uses MySQL instead of SQLite, disables local login/signup, and allows Google OIDC only. The DB points at a MySQL server you already operate.

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

Notes:

- Never use the example `CHANGE_ME_*` values as real passwords.
- Moving the DB to MySQL does not remove the need for the signing key — keep the `/app/data` volume for `sync-api`.

OIDC inputs

- `OIDC_ISSUER_URL`
- `OIDC_CLIENT_ID`
- `OIDC_CLIENT_SECRET`
- `OIDC_REDIRECT_URL`
- `OIDC_SCOPES`

`OIDC_REDIRECT_URL` must exactly match the externally reachable URL.

## Passkey (WebAuthn) login

You can additionally enable passkeys for browser login (they coexist with passwords and OIDC).

- Turn it on with `WEBAUTHN_ENABLED: "true"`. `PUBLIC_BASE_URL` must be an **HTTPS domain** (no IPs or plain HTTP; `localhost` is the only development exception). If the conditions are not met, it is automatically disabled at boot.
- RP values are derived from `PUBLIC_BASE_URL` automatically; override them with `WEBAUTHN_RP_ID` / `WEBAUTHN_RP_DISPLAY_NAME` / `WEBAUTHN_ORIGINS` if needed.
- Passkeys are bound to the domain they were registered on — if the domain changes, they must be re-registered.

## Running from a config file

Instead of environment variables, you can run from a JSON config file. It is convenient for OIDC/passkey setups where the number of settings grows, or when you want the configuration under version control.

`sync-api` checks the following paths in order and **automatically reads the first config file it finds:**

```text
./config.json
./config/config.json
/etc/dolgate/config.json
```

- Relative paths are resolved against the working directory. The container image's working directory is `/app`, so a file mounted at `/app/config.json` or `/app/config/config.json` is picked up as-is.
- To use a different location, set the path explicitly with `DOLSSH_API_CONFIG_PATH` (this skips the automatic search).
- **Environment variables override file values** (applied in order: file → env). You can keep only the secrets in environment variables and mix the two.

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

Example of mounting it into the container:

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

- Omitted settings fall back to defaults (see [default values](#common-environment-variables) below).
- Secrets (`clientSecret`, DB passwords, `signingPrivateKeyPem`) end up in the file — restrict its permissions and never commit it to a repository.
- The boot log prints which configuration was read, so you can confirm what was applied.

## Common environment variables

`sync-api` can also run on environment variables alone, without a config file (when mixed with a config file, environment variables win — see [Running from a config file](#running-from-a-config-file) above).

Main variables:

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

Default values:

- `PORT`: `8080`
- `DB_DRIVER`: `sqlite` (`mysql` and `postgres` are also supported)
- `DATABASE_URL`: `file:./data/dolgate_sync.db` (SQLite only: `busy_timeout=5000` and
  `journal_mode=WAL` are added automatically for any pragma you do not set yourself, so
  `?_pragma=journal_mode(DELETE)` stays in effect if you need the older journal mode — for example
  when the database file lives on a network filesystem, where WAL is not supported)
- `AUTH_SIGNING_PRIVATE_KEY_PATH`: `./data/auth-signing-private.pem`
- `LOCAL_AUTH_ENABLED`: `true`
- `LOCAL_SIGNUP_ENABLED`: `true`
- `OIDC_ENABLED`: `false`
- `WEBAUTHN_ENABLED`: `false` (enabling it requires `PUBLIC_BASE_URL` to be an HTTPS domain — see the passkey section above)

For PostgreSQL, set `DB_DRIVER=postgres` with a PostgreSQL DSN.

```text
DATABASE_URL=host=127.0.0.1 user=dolgate_user password=CHANGE_ME_PASSWORD dbname=dolgate port=5432 sslmode=disable TimeZone=UTC
```

## Notes on the signing key

`sync-api` signs access tokens, browser login state, and offline leases with the same RS256 signing keypair.

Operational tips:

- For a single instance, the auto-generated `/app/data/auth-signing-private.pem` is sufficient.
- For multi-instance deployments or key rotation policies, inject your own PEM.
- An injected PEM takes precedence over the auto-generated one.

Supported methods:

- `AUTH_SIGNING_PRIVATE_KEY_PEM`
- `AUTH_SIGNING_PRIVATE_KEY_PATH`

## Related documents

- [Build and deploy](./build-and-deploy.md)
- [Architecture](./architecture.md)
