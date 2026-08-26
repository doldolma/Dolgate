import { app } from 'electron';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { normalizeServerUrl } from '@shared';
import { t } from './i18n';

const STORAGE_DIRNAME = 'storage';
const ACCOUNTS_DIRNAME = 'accounts';
const LOCAL_ONLY_DIRNAME = 'local-only';
const ACTIVITY_LOG_FILE_NAME = 'activity-log.jsonl';
const SESSION_REPLAYS_DIRNAME = 'session-replays';

/**
 * 기록(활동 로그·세션 리플레이)이 어느 자리에 쌓이는가.
 *
 * 계정으로 쓰면 그 계정의 자리, 계정 없이 쓰면 이 기기의 로컬 전용 자리다. **계정 없이 쓰는
 * 모드에는 userId 가 없다** — 예전에는 그런 소유자를 표현할 방법이 아예 없어서 그 모드에서는
 * 범위가 잡히지 않았고, 기록이 조용히 버려졌다(appendActivityLog 는 자리가 없으면 아무것도
 * 하지 않고 정상 반환한다).
 */
export type LocalHistoryOwner =
  | { kind?: 'account'; userId: string; serverUrl: string }
  | { kind: 'local-only' };

/** 계정 없이 쓰는 기기의 기록 자리. */
export const LOCAL_ONLY_HISTORY_OWNER: LocalHistoryOwner = { kind: 'local-only' };

export interface LocalHistoryScope {
  id: string;
  directoryPath: string;
  activityLogFilePath: string;
  replayDirectoryPath: string;
  legacyActivityLogFilePath: string;
  legacyReplayDirectoryPath: string;
}

function resolveUserDataPath(): string {
  const override = process.env.DOLSSH_USER_DATA_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  if (app?.getPath) {
    return app.getPath('userData');
  }
  return path.join(process.cwd(), '.tmp', `dolssh-desktop-storage-${process.pid}`);
}

export function resolveLocalHistoryScope(
  owner: LocalHistoryOwner,
): LocalHistoryScope {
  const storageDirectoryPath = path.join(resolveUserDataPath(), STORAGE_DIRNAME);

  // 계정 없이 쓰는 자리는 accounts/ 밖에 둔다. 안에 두면 계정 하나로 보이고, 계정 폴더를
  // 훑는 정리·삭제가 이 기록까지 함께 지운다.
  if (owner.kind === 'local-only') {
    return buildScope(LOCAL_ONLY_DIRNAME, storageDirectoryPath, LOCAL_ONLY_DIRNAME);
  }

  const normalizedServerUrl = normalizeServerUrl(owner.serverUrl);
  const normalizedUserId = owner.userId.trim();
  if (!normalizedUserId) {
    throw new Error(t('misc.noUserIdForHistory'));
  }

  const scopeId = createHash('sha256')
    .update(`${normalizedServerUrl}\0${normalizedUserId}`, 'utf8')
    .digest('hex');
  return buildScope(
    scopeId,
    storageDirectoryPath,
    path.join(ACCOUNTS_DIRNAME, scopeId),
  );
}

function buildScope(
  id: string,
  storageDirectoryPath: string,
  relativeDirectory: string,
): LocalHistoryScope {
  const directoryPath = path.join(storageDirectoryPath, relativeDirectory);

  return {
    id,
    directoryPath,
    activityLogFilePath: path.join(directoryPath, ACTIVITY_LOG_FILE_NAME),
    replayDirectoryPath: path.join(directoryPath, SESSION_REPLAYS_DIRNAME),
    legacyActivityLogFilePath: path.join(
      storageDirectoryPath,
      ACTIVITY_LOG_FILE_NAME,
    ),
    legacyReplayDirectoryPath: path.join(
      storageDirectoryPath,
      SESSION_REPLAYS_DIRNAME,
    ),
  };
}

/**
 * 계정 없이 쌓아 둔 기록을 계정 자리로 옮긴다.
 *
 * 계정 없이 쓰다가 로그인하면 호스트·설정이 그 계정으로 올라간다. 기록만 남겨 두면 로그인하는
 * 순간 "그동안 한 일" 이 목록에서 통째로 사라진다 — 지워진 것처럼 보이지만 실은 다른 폴더에
 * 있을 뿐이라, 되찾을 방법도 화면에 없다. 그래서 함께 옮긴다.
 *
 * **동기화가 아니라 이 기기 안의 이사다.** 활동 로그와 리플레이는 서버로 가지 않는다.
 *
 * 이미 계정 자리에 있는 것은 지우지 않는다 — 로그는 이어 붙이고(읽는 쪽이 시각으로 정렬한다),
 * 리플레이는 이름이 겹치지 않는 것만 옮긴다. 옮긴 뒤 로컬 전용 자리는 비운다.
 */
export function migrateLocalOnlyHistoryInto(target: LocalHistoryScope): void {
  const source = resolveLocalHistoryScope(LOCAL_ONLY_HISTORY_OWNER);
  if (source.id === target.id) {
    return;
  }

  if (existsSync(source.activityLogFilePath)) {
    mkdirSync(path.dirname(target.activityLogFilePath), { recursive: true });
    appendFileSync(
      target.activityLogFilePath,
      readFileSync(source.activityLogFilePath, 'utf8'),
      'utf8',
    );
    rmSync(source.activityLogFilePath, { force: true });
  }

  if (existsSync(source.replayDirectoryPath)) {
    mkdirSync(target.replayDirectoryPath, { recursive: true });
    for (const entry of readdirSync(source.replayDirectoryPath)) {
      const from = path.join(source.replayDirectoryPath, entry);
      const to = path.join(target.replayDirectoryPath, entry);
      if (existsSync(to)) {
        // 같은 이름이 이미 있다 = 이 계정에 같은 녹화가 있다. 덮어쓰지 않는다.
        rmSync(from, { force: true, recursive: true });
        continue;
      }
      renameSync(from, to);
    }
    rmSync(source.replayDirectoryPath, { force: true, recursive: true });
  }
}
