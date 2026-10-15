import { describe, expect, it } from 'vitest';
import type { TransferJob } from '@shared';
import {
  buildTransferPathTooltip,
  formatTransferFolderPath,
  getTransferTargetFolder,
} from './transfer-format';

function createJob(overrides: Partial<TransferJob> = {}): TransferJob {
  return {
    id: 'job-1',
    sourceLabel: 'nas',
    targetLabel: 'Local',
    itemCount: 1,
    bytesTotal: 100,
    bytesCompleted: 100,
    status: 'completed',
    startedAt: '2026-10-15T00:00:00.000Z',
    updatedAt: '2026-10-15T00:00:01.000Z',
    request: {
      source: { kind: 'remote', path: '/home/Drive/스터디/최적화', endpointId: 'endpoint-1' },
      target: { kind: 'local', path: '/Users/tester/Downloads/abc' },
      items: [{ name: '파이썬 최적화 자료.pdf', path: '/home/Drive/스터디/최적화/파이썬 최적화 자료.pdf', isDirectory: false, size: 100 }],
      conflictResolution: 'overwrite',
    },
    ...overrides,
  };
}

// 전송 카드에 받는 폴더를 보인다. 어디로 받았는지가 안 보여, 엉뚱한 폴더로 들어가도 알 수 없었다.
describe('formatTransferFolderPath', () => {
  it('shortens the local home to ~', () => {
    expect(formatTransferFolderPath('/Users/tester/Downloads/abc', '/Users/tester')).toBe('~/Downloads/abc');
    expect(formatTransferFolderPath('/Users/tester', '/Users/tester/')).toBe('~');
  });

  it('leaves a path outside the home as it is', () => {
    expect(formatTransferFolderPath('/home/Drive/스터디/최적화', '/Users/tester')).toBe('/home/Drive/스터디/최적화');
    expect(formatTransferFolderPath('/Users/testerX/a', '/Users/tester')).toBe('/Users/testerX/a');
  });

  it('cuts the middle of a long path and keeps the last folders', () => {
    const shortened = formatTransferFolderPath(
      '/Users/tester/Downloads/project/very/long/folder/structure/스터디/최적화',
      '/Users/tester',
    );
    expect(shortened.startsWith('~/…/')).toBe(true);
    expect(shortened.endsWith('/스터디/최적화')).toBe(true);
  });

  it('keeps Windows separators', () => {
    expect(formatTransferFolderPath('C:\\Users\\tester\\Downloads', 'C:\\Users\\tester')).toBe('~\\Downloads');
    const shortened = formatTransferFolderPath(
      'D:\\work\\projects\\client-a\\deliverables\\2026\\october\\final-build',
      'C:\\Users\\tester',
    );
    expect(shortened).toBe('D:\\…\\2026\\october\\final-build');
  });
});

describe('transfer card paths', () => {
  it('gives the destination folder and both full paths', () => {
    const job = createJob();
    expect(getTransferTargetFolder(job)).toBe('/Users/tester/Downloads/abc');
    expect(buildTransferPathTooltip(job)).toBe(
      '보낸 곳 nas:/home/Drive/스터디/최적화\n받는 곳 /Users/tester/Downloads/abc',
    );
  });

  it('has nothing to show for a job without its request', () => {
    const job = createJob({ request: undefined });
    expect(getTransferTargetFolder(job)).toBeNull();
    expect(buildTransferPathTooltip(job)).toBeNull();
  });
});
