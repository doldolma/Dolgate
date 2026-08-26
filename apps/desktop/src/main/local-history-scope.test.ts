// 기록이 쌓이는 자리. **계정이 없어도 자리가 있어야 한다** — 없으면 활동 로그가 조용히 버려진다
// (state-storage 의 appendActivityLog 는 자리가 없으면 아무것도 하지 않고 정상 반환한다).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: undefined }));
vi.mock('./i18n', () => ({ t: (key: string) => key }));

import {
  LOCAL_ONLY_HISTORY_OWNER,
  migrateLocalOnlyHistoryInto,
  resolveLocalHistoryScope,
} from './local-history-scope';

let userDataDir: string;

beforeEach(() => {
  userDataDir = mkdtempSync(path.join(tmpdir(), 'dolgate-history-'));
  process.env.DOLSSH_USER_DATA_DIR = userDataDir;
});

afterEach(() => {
  delete process.env.DOLSSH_USER_DATA_DIR;
  rmSync(userDataDir, { recursive: true, force: true });
});

const ACCOUNT = { userId: 'user-1', serverUrl: 'https://sync.example.com' };

describe('기록 자리', () => {
  it('계정이 없어도 자리가 있다', () => {
    const scope = resolveLocalHistoryScope(LOCAL_ONLY_HISTORY_OWNER);
    expect(scope.activityLogFilePath).toBeTruthy();
    expect(scope.replayDirectoryPath).toBeTruthy();
  });

  // accounts/ 안에 두면 계정 하나로 보이고, 계정 폴더를 훑는 정리·삭제가 이 기록까지 지운다.
  it('계정 없이 쓰는 자리는 계정 폴더 밖이다', () => {
    const local = resolveLocalHistoryScope(LOCAL_ONLY_HISTORY_OWNER);
    const account = resolveLocalHistoryScope(ACCOUNT);
    expect(account.directoryPath).toContain(`${path.sep}accounts${path.sep}`);
    expect(local.directoryPath).not.toContain(`${path.sep}accounts${path.sep}`);
    expect(local.id).not.toBe(account.id);
  });

  it('계정 자리는 계정마다 다르다', () => {
    const other = resolveLocalHistoryScope({ ...ACCOUNT, userId: 'user-2' });
    expect(resolveLocalHistoryScope(ACCOUNT).id).not.toBe(other.id);
  });
});

/**
 * 계정 없이 쓰다가 로그인하면 호스트·설정이 그 계정으로 올라간다. 기록만 남겨 두면 로그인하는
 * 순간 "그동안 한 일" 이 목록에서 통째로 사라진다.
 */
describe('로그인할 때 기록을 계정 자리로 옮긴다', () => {
  function seedLocalOnly(logLine: string, replayName?: string): void {
    const local = resolveLocalHistoryScope(LOCAL_ONLY_HISTORY_OWNER);
    mkdirSync(local.directoryPath, { recursive: true });
    writeFileSync(local.activityLogFilePath, `${logLine}\n`, 'utf8');
    if (replayName) {
      mkdirSync(local.replayDirectoryPath, { recursive: true });
      writeFileSync(path.join(local.replayDirectoryPath, replayName), 'events', 'utf8');
    }
  }

  it('로그와 리플레이가 계정 자리로 옮겨지고 원래 자리는 비워진다', () => {
    seedLocalOnly('{"id":"a"}', 'rec-1.jsonl');
    const account = resolveLocalHistoryScope(ACCOUNT);

    migrateLocalOnlyHistoryInto(account);

    expect(readFileSync(account.activityLogFilePath, 'utf8')).toContain('"id":"a"');
    expect(existsSync(path.join(account.replayDirectoryPath, 'rec-1.jsonl'))).toBe(true);

    const local = resolveLocalHistoryScope(LOCAL_ONLY_HISTORY_OWNER);
    expect(existsSync(local.activityLogFilePath)).toBe(false);
    expect(existsSync(local.replayDirectoryPath)).toBe(false);
  });

  // 이미 그 계정으로 쓰던 기기라면 계정 자리에 기록이 있다. 옮기면서 덮으면 그것이 사라진다.
  it('계정에 이미 있던 기록을 덮지 않는다', () => {
    const account = resolveLocalHistoryScope(ACCOUNT);
    mkdirSync(account.replayDirectoryPath, { recursive: true });
    writeFileSync(account.activityLogFilePath, '{"id":"old"}\n', 'utf8');
    writeFileSync(path.join(account.replayDirectoryPath, 'rec-1.jsonl'), 'account', 'utf8');
    seedLocalOnly('{"id":"new"}', 'rec-1.jsonl');

    migrateLocalOnlyHistoryInto(account);

    const merged = readFileSync(account.activityLogFilePath, 'utf8');
    expect(merged).toContain('"id":"old"');
    expect(merged).toContain('"id":"new"');
    // 이름이 겹치는 녹화는 계정 것을 남긴다.
    expect(readFileSync(path.join(account.replayDirectoryPath, 'rec-1.jsonl'), 'utf8')).toBe(
      'account',
    );
  });

  it('옮길 것이 없으면 아무 일도 하지 않는다', () => {
    const account = resolveLocalHistoryScope(ACCOUNT);
    expect(() => migrateLocalOnlyHistoryInto(account)).not.toThrow();
    expect(existsSync(account.activityLogFilePath)).toBe(false);
  });

  it('로컬 전용 자리로는 옮기지 않는다', () => {
    seedLocalOnly('{"id":"a"}');
    const local = resolveLocalHistoryScope(LOCAL_ONLY_HISTORY_OWNER);

    migrateLocalOnlyHistoryInto(local);

    // 자기 자신으로 옮기면 원본이 지워진다 — 그 경우는 아무것도 하지 않아야 한다.
    expect(readFileSync(local.activityLogFilePath, 'utf8')).toContain('"id":"a"');
  });
});
