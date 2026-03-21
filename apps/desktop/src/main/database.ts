import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type {
  ActivityLogCategory,
  ActivityLogLevel,
  ActivityLogRecord,
  AppSettings,
  AppTheme,
  GroupRecord,
  HostDraft,
  HostRecord,
  KnownHostRecord,
  KnownHostTrustInput,
  PortForwardDraft,
  PortForwardRuleRecord,
  SecretMetadataRecord,
  SecretSource
} from '@dolssh/shared';

const MAX_ACTIVITY_LOGS = 10_000;

function nowIso(): string {
  return new Date().toISOString();
}

function databasePath(): string {
  const dbDir = path.join(app.getPath('userData'), 'data');
  mkdirSync(dbDir, { recursive: true });
  return path.join(dbDir, 'dolssh.db');
}

function openDatabase(): Database.Database {
  const db = new Database(databasePath());
  // WAL 모드는 데스크톱 앱에서 읽기/쓰기 충돌을 줄이는 데 유리하다.
  db.pragma('journal_mode = WAL');
  return db;
}

function normalizeGroupPath(groupPath?: string | null): string | null {
  const normalized = (groupPath ?? '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean)
    .join('/');
  return normalized.length > 0 ? normalized : null;
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'string') {
    return null;
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

// SQLite row를 renderer가 쓰는 HostRecord 형태로 변환한다.
function toHostRecord(row: Record<string, unknown>): HostRecord {
  return {
    id: String(row.id),
    label: String(row.label),
    hostname: String(row.hostname),
    port: Number(row.port),
    username: String(row.username),
    authType: row.auth_type === 'privateKey' ? 'privateKey' : 'password',
    privateKeyPath: row.private_key_path ? String(row.private_key_path) : null,
    secretRef: row.secret_ref ? String(row.secret_ref) : null,
    groupName: row.group_name ? String(row.group_name) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toAppSettings(row: Record<string, unknown> | undefined): AppSettings {
  return {
    theme: row?.theme === 'light' || row?.theme === 'dark' ? (row.theme as AppTheme) : 'system',
    dismissedUpdateVersion: row?.dismissed_update_version ? String(row.dismissed_update_version) : null,
    updatedAt: row?.updated_at ? String(row.updated_at) : nowIso()
  };
}

function toGroupRecord(row: Record<string, unknown>): GroupRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    path: String(row.path),
    parentPath: row.parent_path ? String(row.parent_path) : null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toPortForwardRecord(row: Record<string, unknown>): PortForwardRuleRecord {
  return {
    id: String(row.id),
    label: String(row.label),
    hostId: String(row.host_id),
    mode: row.mode === 'remote' || row.mode === 'dynamic' ? (row.mode as 'remote' | 'dynamic') : 'local',
    bindAddress: String(row.bind_address),
    bindPort: Number(row.bind_port),
    targetHost: row.target_host ? String(row.target_host) : null,
    targetPort: row.target_port === null || row.target_port === undefined ? null : Number(row.target_port),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at)
  };
}

function toKnownHostRecord(row: Record<string, unknown>): KnownHostRecord {
  return {
    id: String(row.id),
    host: String(row.host),
    port: Number(row.port),
    algorithm: String(row.algorithm),
    publicKeyBase64: String(row.public_key_base64),
    fingerprintSha256: String(row.fingerprint_sha256),
    createdAt: String(row.created_at),
    lastSeenAt: String(row.last_seen_at),
    updatedAt: String(row.updated_at)
  };
}

function toActivityLogRecord(row: Record<string, unknown>): ActivityLogRecord {
  return {
    id: String(row.id),
    level: row.level === 'warn' || row.level === 'error' ? (row.level as ActivityLogLevel) : 'info',
    category:
      row.category === 'sftp' ||
      row.category === 'forwarding' ||
      row.category === 'known_hosts' ||
      row.category === 'keychain'
        ? (row.category as ActivityLogCategory)
        : 'ssh',
    message: String(row.message),
    metadata: parseJsonObject(row.metadata_json),
    createdAt: String(row.created_at)
  };
}

function toSecretMetadataRecord(row: Record<string, unknown>): SecretMetadataRecord {
  return {
    hostId: String(row.host_id),
    hostLabel: String(row.host_label),
    hostname: String(row.hostname),
    username: String(row.username),
    secretRef: String(row.secret_ref),
    hasPassword: Boolean(row.has_password),
    hasPassphrase: Boolean(row.has_passphrase),
    hasManagedPrivateKey: Boolean(row.has_managed_private_key),
    source: row.source === 'server_managed' ? 'server_managed' : 'local_keychain',
    updatedAt: String(row.updated_at)
  };
}

export class HostRepository {
  private readonly db: Database.Database;

  constructor() {
    // 앱 사용자 데이터 디렉터리 아래에 로컬 DB를 둬서 운영체제별 경로 차이를 숨긴다.
    this.db = openDatabase();
    this.migrate();
  }

  private migrate(): void {
    // hosts 테이블은 여전히 로컬 호스트 메타데이터의 단일 소스다.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hosts (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        hostname TEXT NOT NULL,
        port INTEGER NOT NULL,
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL,
        private_key_path TEXT,
        secret_ref TEXT,
        group_name TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  list(): HostRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, label, hostname, port, username, auth_type, private_key_path, secret_ref, group_name, created_at, updated_at
      FROM hosts
      ORDER BY COALESCE(group_name, ''), label, hostname
    `);
    return stmt.all().map((row) => toHostRecord(row as Record<string, unknown>));
  }

  getById(id: string): HostRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, label, hostname, port, username, auth_type, private_key_path, secret_ref, group_name, created_at, updated_at
      FROM hosts
      WHERE id = ?
    `);
    const row = stmt.get(id) as Record<string, unknown> | undefined;
    return row ? toHostRecord(row) : null;
  }

  create(id: string, draft: HostDraft, secretRef?: string | null): HostRecord {
    const timestamp = nowIso();
    this.db
      .prepare(`
        INSERT INTO hosts (id, label, hostname, port, username, auth_type, private_key_path, secret_ref, group_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        draft.label,
        draft.hostname,
        draft.port,
        draft.username,
        draft.authType,
        draft.privateKeyPath ?? null,
        secretRef ?? draft.secretRef ?? null,
        normalizeGroupPath(draft.groupName),
        timestamp,
        timestamp
      );
    return this.getById(id)!;
  }

  update(id: string, draft: HostDraft, secretRef?: string | null): HostRecord {
    this.db
      .prepare(`
        UPDATE hosts
        SET label = ?, hostname = ?, port = ?, username = ?, auth_type = ?, private_key_path = ?, secret_ref = ?, group_name = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        draft.label,
        draft.hostname,
        draft.port,
        draft.username,
        draft.authType,
        draft.privateKeyPath ?? null,
        secretRef ?? draft.secretRef ?? null,
        normalizeGroupPath(draft.groupName),
        nowIso(),
        id
      );
    return this.getById(id)!;
  }

  updateSecretRef(id: string, secretRef: string | null): HostRecord | null {
    this.db
      .prepare(`
        UPDATE hosts
        SET secret_ref = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(secretRef, nowIso(), id);
    return this.getById(id);
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM hosts WHERE id = ?`).run(id);
  }
}

export class GroupRepository {
  private readonly db: Database.Database;

  constructor() {
    // 그룹도 같은 로컬 DB에 저장해 홈 화면의 탐색 상태와 일관되게 유지한다.
    this.db = openDatabase();
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        parent_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  list(): GroupRecord[] {
    const stmt = this.db.prepare(`
      SELECT id, name, path, parent_path, created_at, updated_at
      FROM groups
      ORDER BY path
    `);
    return stmt.all().map((row) => toGroupRecord(row as Record<string, unknown>));
  }

  getByPath(targetPath: string): GroupRecord | null {
    const stmt = this.db.prepare(`
      SELECT id, name, path, parent_path, created_at, updated_at
      FROM groups
      WHERE path = ?
    `);
    const row = stmt.get(targetPath) as Record<string, unknown> | undefined;
    return row ? toGroupRecord(row) : null;
  }

  create(id: string, name: string, parentPath?: string | null): GroupRecord {
    const cleanedName = name.trim();
    if (!cleanedName) {
      throw new Error('Group name is required');
    }

    const normalizedParentPath = normalizeGroupPath(parentPath);
    const nextPath = normalizeGroupPath(normalizedParentPath ? `${normalizedParentPath}/${cleanedName}` : cleanedName);
    if (!nextPath) {
      throw new Error('Group path is invalid');
    }
    if (this.getByPath(nextPath)) {
      throw new Error('Group already exists');
    }

    const timestamp = nowIso();
    this.db
      .prepare(`
        INSERT INTO groups (id, name, path, parent_path, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(id, cleanedName, nextPath, normalizedParentPath, timestamp, timestamp);

    return this.getByPath(nextPath)!;
  }
}

export class SettingsRepository {
  private readonly db: Database.Database;

  constructor() {
    // 설정도 동일한 로컬 DB에 넣어 백업과 관리 경로를 단순하게 유지한다.
    this.db = openDatabase();
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_settings (
        singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
        theme TEXT NOT NULL,
        dismissed_update_version TEXT,
        updated_at TEXT NOT NULL
      );
    `);

    const columns = this.db
      .prepare(`PRAGMA table_info(app_settings)`)
      .all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'dismissed_update_version')) {
      this.db.exec(`
        ALTER TABLE app_settings
        ADD COLUMN dismissed_update_version TEXT
      `);
    }

    this.db
      .prepare(`
        INSERT INTO app_settings (singleton_id, theme, dismissed_update_version, updated_at)
        VALUES (1, 'system', NULL, ?)
        ON CONFLICT(singleton_id) DO NOTHING
      `)
      .run(nowIso());
  }

  get(): AppSettings {
    const row = this.db
      .prepare(`
        SELECT theme, dismissed_update_version, updated_at
        FROM app_settings
        WHERE singleton_id = 1
      `)
      .get() as Record<string, unknown> | undefined;
    return toAppSettings(row);
  }

  update(input: Partial<AppSettings>): AppSettings {
    const current = this.get();
    const theme = input.theme === 'light' || input.theme === 'dark' || input.theme === 'system' ? input.theme : current.theme;
    const dismissedUpdateVersion = Object.prototype.hasOwnProperty.call(input, 'dismissedUpdateVersion')
      ? input.dismissedUpdateVersion ?? null
      : current.dismissedUpdateVersion ?? null;
    this.db
      .prepare(`
        UPDATE app_settings
        SET theme = ?, dismissed_update_version = ?, updated_at = ?
        WHERE singleton_id = 1
      `)
      .run(theme, dismissedUpdateVersion, nowIso());
    return this.get();
  }
}

export class PortForwardRepository {
  private readonly db: Database.Database;

  constructor() {
    this.db = openDatabase();
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS port_forwards (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        host_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        bind_address TEXT NOT NULL,
        bind_port INTEGER NOT NULL,
        target_host TEXT,
        target_port INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  list(): PortForwardRuleRecord[] {
    return this.db
      .prepare(`
        SELECT id, label, host_id, mode, bind_address, bind_port, target_host, target_port, created_at, updated_at
        FROM port_forwards
        ORDER BY updated_at DESC, label
      `)
      .all()
      .map((row) => toPortForwardRecord(row as Record<string, unknown>));
  }

  getById(id: string): PortForwardRuleRecord | null {
    const row = this.db
      .prepare(`
        SELECT id, label, host_id, mode, bind_address, bind_port, target_host, target_port, created_at, updated_at
        FROM port_forwards
        WHERE id = ?
      `)
      .get(id) as Record<string, unknown> | undefined;
    return row ? toPortForwardRecord(row) : null;
  }

  create(draft: PortForwardDraft): PortForwardRuleRecord {
    const id = randomUUID();
    const timestamp = nowIso();
    this.db
      .prepare(`
        INSERT INTO port_forwards (id, label, host_id, mode, bind_address, bind_port, target_host, target_port, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        draft.label.trim(),
        draft.hostId,
        draft.mode,
        draft.bindAddress.trim(),
        draft.bindPort,
        draft.mode === 'dynamic' ? null : draft.targetHost?.trim() ?? null,
        draft.mode === 'dynamic' ? null : draft.targetPort ?? null,
        timestamp,
        timestamp
      );
    return this.getById(id)!;
  }

  update(id: string, draft: PortForwardDraft): PortForwardRuleRecord {
    this.db
      .prepare(`
        UPDATE port_forwards
        SET label = ?, host_id = ?, mode = ?, bind_address = ?, bind_port = ?, target_host = ?, target_port = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(
        draft.label.trim(),
        draft.hostId,
        draft.mode,
        draft.bindAddress.trim(),
        draft.bindPort,
        draft.mode === 'dynamic' ? null : draft.targetHost?.trim() ?? null,
        draft.mode === 'dynamic' ? null : draft.targetPort ?? null,
        nowIso(),
        id
      );
    return this.getById(id)!;
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM port_forwards WHERE id = ?`).run(id);
  }
}

export class KnownHostRepository {
  private readonly db: Database.Database;

  constructor() {
    this.db = openDatabase();
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS known_hosts (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        port INTEGER NOT NULL,
        algorithm TEXT NOT NULL,
        public_key_base64 TEXT NOT NULL,
        fingerprint_sha256 TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(host, port)
      );
    `);
  }

  list(): KnownHostRecord[] {
    return this.db
      .prepare(`
        SELECT id, host, port, algorithm, public_key_base64, fingerprint_sha256, created_at, last_seen_at, updated_at
        FROM known_hosts
        ORDER BY host, port
      `)
      .all()
      .map((row) => toKnownHostRecord(row as Record<string, unknown>));
  }

  getByHostPort(host: string, port: number): KnownHostRecord | null {
    const row = this.db
      .prepare(`
        SELECT id, host, port, algorithm, public_key_base64, fingerprint_sha256, created_at, last_seen_at, updated_at
        FROM known_hosts
        WHERE host = ? AND port = ?
      `)
      .get(host, port) as Record<string, unknown> | undefined;
    return row ? toKnownHostRecord(row) : null;
  }

  trust(input: KnownHostTrustInput): KnownHostRecord {
    const current = this.getByHostPort(input.host, input.port);
    const timestamp = nowIso();
    if (current) {
      this.db
        .prepare(`
          UPDATE known_hosts
          SET algorithm = ?, public_key_base64 = ?, fingerprint_sha256 = ?, last_seen_at = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(input.algorithm, input.publicKeyBase64, input.fingerprintSha256, timestamp, timestamp, current.id);
      return this.getByHostPort(input.host, input.port)!;
    }

    const id = randomUUID();
    this.db
      .prepare(`
        INSERT INTO known_hosts (id, host, port, algorithm, public_key_base64, fingerprint_sha256, created_at, last_seen_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(id, input.host, input.port, input.algorithm, input.publicKeyBase64, input.fingerprintSha256, timestamp, timestamp, timestamp);
    return this.getByHostPort(input.host, input.port)!;
  }

  touch(host: string, port: number): void {
    this.db
      .prepare(`
        UPDATE known_hosts
        SET last_seen_at = ?, updated_at = ?
        WHERE host = ? AND port = ?
      `)
      .run(nowIso(), nowIso(), host, port);
  }

  remove(id: string): void {
    this.db.prepare(`DELETE FROM known_hosts WHERE id = ?`).run(id);
  }
}

export class ActivityLogRepository {
  private readonly db: Database.Database;

  constructor() {
    this.db = openDatabase();
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS activity_logs (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  list(): ActivityLogRecord[] {
    return this.db
      .prepare(`
        SELECT id, level, category, message, metadata_json, created_at
        FROM activity_logs
        ORDER BY created_at DESC
      `)
      .all()
      .map((row) => toActivityLogRecord(row as Record<string, unknown>));
  }

  append(level: ActivityLogLevel, category: ActivityLogCategory, message: string, metadata?: Record<string, unknown> | null): ActivityLogRecord {
    const id = randomUUID();
    const createdAt = nowIso();
    this.db
      .prepare(`
        INSERT INTO activity_logs (id, level, category, message, metadata_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(id, level, category, message, metadata ? JSON.stringify(metadata) : null, createdAt);
    this.prune();
    return {
      id,
      level,
      category,
      message,
      metadata: metadata ?? null,
      createdAt
    };
  }

  clear(): void {
    this.db.prepare(`DELETE FROM activity_logs`).run();
  }

  private prune(): void {
    this.db
      .prepare(`
        DELETE FROM activity_logs
        WHERE id IN (
          SELECT id
          FROM activity_logs
          ORDER BY created_at DESC
          LIMIT -1 OFFSET ?
        )
      `)
      .run(MAX_ACTIVITY_LOGS);
  }
}

export class SecretMetadataRepository {
  private readonly db: Database.Database;

  constructor() {
    this.db = openDatabase();
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS host_secret_metadata (
        host_id TEXT PRIMARY KEY,
        secret_ref TEXT NOT NULL,
        has_password INTEGER NOT NULL,
        has_passphrase INTEGER NOT NULL,
        has_managed_private_key INTEGER NOT NULL,
        source TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  upsert(input: {
    hostId: string;
    secretRef: string;
    hasPassword: boolean;
    hasPassphrase: boolean;
    hasManagedPrivateKey?: boolean;
    source?: SecretSource;
  }): void {
    this.db
      .prepare(`
        INSERT INTO host_secret_metadata (
          host_id,
          secret_ref,
          has_password,
          has_passphrase,
          has_managed_private_key,
          source,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host_id) DO UPDATE SET
          secret_ref = excluded.secret_ref,
          has_password = excluded.has_password,
          has_passphrase = excluded.has_passphrase,
          has_managed_private_key = excluded.has_managed_private_key,
          source = excluded.source,
          updated_at = excluded.updated_at
      `)
      .run(
        input.hostId,
        input.secretRef,
        input.hasPassword ? 1 : 0,
        input.hasPassphrase ? 1 : 0,
        input.hasManagedPrivateKey ? 1 : 0,
        input.source ?? 'local_keychain',
        nowIso()
      );
  }

  removeByHostId(hostId: string): void {
    this.db.prepare(`DELETE FROM host_secret_metadata WHERE host_id = ?`).run(hostId);
  }

  list(): SecretMetadataRecord[] {
    return this.db
      .prepare(`
        SELECT
          m.host_id,
          h.label AS host_label,
          h.hostname,
          h.username,
          m.secret_ref,
          m.has_password,
          m.has_passphrase,
          m.has_managed_private_key,
          m.source,
          m.updated_at
        FROM host_secret_metadata m
        INNER JOIN hosts h ON h.id = m.host_id
        ORDER BY h.label, h.hostname
      `)
      .all()
      .map((row) => toSecretMetadataRecord(row as Record<string, unknown>));
  }
}
