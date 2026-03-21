import Database from 'better-sqlite3';
import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { AppSettings, AppTheme, GroupRecord, HostDraft, HostRecord } from '@keyterm/shared';

function nowIso(): string {
  return new Date().toISOString();
}

function databasePath(): string {
  const dbDir = path.join(app.getPath('userData'), 'data');
  mkdirSync(dbDir, { recursive: true });
  return path.join(dbDir, 'keyterm.db');
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

export class HostRepository {
  private readonly db: Database.Database;

  constructor() {
    // 앱 사용자 데이터 디렉터리 아래에 로컬 DB를 둬서 운영체제별 경로 차이를 숨긴다.
    this.db = openDatabase();
    this.migrate();
  }

  private migrate(): void {
    // MVP 단계에서는 간단한 단일 테이블로 시작하고, 이후 필요 시 마이그레이션 버전을 추가한다.
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
    // 그룹, 라벨, 호스트명 순으로 정렬해 사이드바가 안정적으로 보이게 한다.
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
    // createdAt / updatedAt을 같은 값으로 맞춰 최초 저장 시점을 명확히 한다.
    const timestamp = nowIso();
    const stmt = this.db.prepare(`
      INSERT INTO hosts (id, label, hostname, port, username, auth_type, private_key_path, secret_ref, group_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
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
    // 비밀값은 keychain 참조만 갱신하고 실제 비밀번호는 DB에 저장하지 않는다.
    const stmt = this.db.prepare(`
      UPDATE hosts
      SET label = ?, hostname = ?, port = ?, username = ?, auth_type = ?, private_key_path = ?, secret_ref = ?, group_name = ?, updated_at = ?
      WHERE id = ?
    `);
    stmt.run(
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
        updated_at TEXT NOT NULL
      );
    `);

    this.db
      .prepare(`
        INSERT INTO app_settings (singleton_id, theme, updated_at)
        VALUES (1, 'system', ?)
        ON CONFLICT(singleton_id) DO NOTHING
      `)
      .run(nowIso());
  }

  get(): AppSettings {
    const row = this.db
      .prepare(`
        SELECT theme, updated_at
        FROM app_settings
        WHERE singleton_id = 1
      `)
      .get() as Record<string, unknown> | undefined;
    return toAppSettings(row);
  }

  update(input: Partial<AppSettings>): AppSettings {
    const current = this.get();
    const theme = input.theme === 'light' || input.theme === 'dark' || input.theme === 'system' ? input.theme : current.theme;
    this.db
      .prepare(`
        UPDATE app_settings
        SET theme = ?, updated_at = ?
        WHERE singleton_id = 1
      `)
      .run(theme, nowIso());
    return this.get();
  }
}
