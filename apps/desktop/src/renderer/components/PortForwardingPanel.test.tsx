import { describe, expect, it } from 'vitest';
import type { HostRecord, PortForwardDraft, PortForwardRuleRecord } from '@shared';
import { filterPortForwardRules, getAvailablePortForwardHosts, shouldShowAwsRemoteHostField } from './PortForwardingPanel';

const hosts: HostRecord[] = [
  {
    id: 'ssh-host-1',
    kind: 'ssh',
    label: 'SSH Host',
    hostname: 'ssh.example.com',
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    privateKeyPath: null,
    secretRef: null,
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'aws-host-1',
    kind: 'aws-ec2',
    label: 'Bastion',
    awsProfileName: 'default',
    awsRegion: 'ap-northeast-2',
    awsInstanceId: 'i-123',
    awsInstanceName: 'bastion',
    awsPlatform: null,
    awsPrivateIp: '10.0.0.10',
    awsState: 'running',
    groupName: null,
    tags: [],
    terminalThemeId: null,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

const rules: PortForwardRuleRecord[] = [
  {
    id: 'ssh-rule-1',
    transport: 'ssh',
    label: 'SSH Rule',
    hostId: 'ssh-host-1',
    mode: 'local',
    bindAddress: '127.0.0.1',
    bindPort: 9000,
    targetHost: '127.0.0.1',
    targetPort: 80,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  },
  {
    id: 'aws-rule-1',
    transport: 'aws-ssm',
    label: 'AWS Rule',
    hostId: 'aws-host-1',
    bindAddress: '127.0.0.1',
    bindPort: 15432,
    targetKind: 'remote-host',
    targetPort: 5432,
    remoteHost: 'db.internal',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z'
  }
];

describe('PortForwardingPanel helpers', () => {
  it('filters rules by transport tab', () => {
    expect(filterPortForwardRules(rules, 'ssh').map((rule) => rule.label)).toEqual(['SSH Rule']);
    expect(filterPortForwardRules(rules, 'aws-ssm').map((rule) => rule.label)).toEqual(['AWS Rule']);
  });

  it('returns only matching hosts for each transport tab', () => {
    expect(getAvailablePortForwardHosts(hosts, 'ssh').map((host) => host.label)).toEqual(['SSH Host']);
    expect(getAvailablePortForwardHosts(hosts, 'aws-ssm').map((host) => host.label)).toEqual(['Bastion']);
  });

  it('shows the remote-host field only for AWS remote-host drafts', () => {
    const sshDraft: PortForwardDraft = {
      transport: 'ssh',
      label: 'SSH',
      hostId: 'ssh-host-1',
      mode: 'local',
      bindAddress: '127.0.0.1',
      bindPort: 9000,
      targetHost: '127.0.0.1',
      targetPort: 80
    };
    const awsDraft: PortForwardDraft = {
      transport: 'aws-ssm',
      label: 'AWS',
      hostId: 'aws-host-1',
      bindAddress: '127.0.0.1',
      bindPort: 9000,
      targetKind: 'remote-host',
      targetPort: 5432,
      remoteHost: 'db.internal'
    };

    expect(shouldShowAwsRemoteHostField(sshDraft)).toBe(false);
    expect(shouldShowAwsRemoteHostField(awsDraft)).toBe(true);
  });
});
