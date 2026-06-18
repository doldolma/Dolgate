import { app } from 'electron';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { normalizeServerUrl } from '@shared';

const STORAGE_DIRNAME = 'storage';
const ACCOUNTS_DIRNAME = 'accounts';
const ACTIVITY_LOG_FILE_NAME = 'activity-log.jsonl';
const SESSION_REPLAYS_DIRNAME = 'session-replays';

export interface LocalHistoryOwner {
  userId: string;
  serverUrl: string;
}

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
  const normalizedServerUrl = normalizeServerUrl(owner.serverUrl);
  const normalizedUserId = owner.userId.trim();
  if (!normalizedUserId) {
    throw new Error('로컬 기록을 저장할 사용자 ID가 없습니다.');
  }

  const scopeId = createHash('sha256')
    .update(`${normalizedServerUrl}\0${normalizedUserId}`, 'utf8')
    .digest('hex');
  const storageDirectoryPath = path.join(resolveUserDataPath(), STORAGE_DIRNAME);
  const directoryPath = path.join(storageDirectoryPath, ACCOUNTS_DIRNAME, scopeId);

  return {
    id: scopeId,
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
