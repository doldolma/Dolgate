import { describe, expect, it, vi } from 'vitest';
import { AwsService } from './aws-service';

describe('AwsService.isManagedInstance', () => {
  it('returns true when the target instance is present in the managed instance list', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      ensureSessionManagerPluginAvailable: () => Promise<void>;
      runResolvedCommand: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      isManagedInstance: (profileName: string, region: string, instanceId: string) => Promise<boolean>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.ensureSessionManagerPluginAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        InstanceInformationList: [{ InstanceId: 'i-123', PingStatus: 'Online' }]
      }),
      stderr: '',
      exitCode: 0
    });

    await expect(service.isManagedInstance('default', 'ap-northeast-2', 'i-123')).resolves.toBe(true);
  });

  it('returns false when the instance is not currently managed by SSM', async () => {
    const service = new AwsService() as unknown as {
      ensureAwsCliAvailable: () => Promise<void>;
      ensureSessionManagerPluginAvailable: () => Promise<void>;
      runResolvedCommand: () => Promise<{ stdout: string; stderr: string; exitCode: number }>;
      isManagedInstance: (profileName: string, region: string, instanceId: string) => Promise<boolean>;
    };

    service.ensureAwsCliAvailable = vi.fn().mockResolvedValue(undefined);
    service.ensureSessionManagerPluginAvailable = vi.fn().mockResolvedValue(undefined);
    service.runResolvedCommand = vi.fn().mockResolvedValue({
      stdout: JSON.stringify({
        InstanceInformationList: [{ InstanceId: 'i-123', PingStatus: 'Inactive' }]
      }),
      stderr: '',
      exitCode: 0
    });

    await expect(service.isManagedInstance('default', 'ap-northeast-2', 'i-123')).resolves.toBe(false);
  });
});
