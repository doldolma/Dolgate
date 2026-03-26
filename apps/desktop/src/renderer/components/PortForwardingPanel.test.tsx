import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HostRecord, PortForwardDraft, PortForwardRuleRecord, PortForwardRuntimeRecord } from '@shared';
import { PortForwardingPanel, filterPortForwardRules, getAvailablePortForwardHosts, shouldShowAwsRemoteHostField } from './PortForwardingPanel';

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

const runtimes: PortForwardRuntimeRecord[] = [];

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function renderPanel(options?: { onSave?: (ruleId: string | null, draft: PortForwardDraft) => Promise<void> }) {
  const onSave = options?.onSave ?? vi.fn().mockResolvedValue(undefined);
  const onRemove = vi.fn().mockResolvedValue(undefined);
  const onStart = vi.fn().mockResolvedValue(undefined);
  const onStop = vi.fn().mockResolvedValue(undefined);
  const view = render(
    <PortForwardingPanel
      hosts={hosts}
      rules={rules}
      runtimes={runtimes}
      onSave={onSave}
      onRemove={onRemove}
      onStart={onStart}
      onStop={onStop}
    />
  );

  return {
    ...view,
    onSave,
    onRemove,
    onStart,
    onStop
  };
}

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

describe('PortForwardingPanel dialog', () => {
  it('exposes an accessible close button for the dialog', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'New SSH Forward' }));

    fireEvent.click(screen.getByRole('button', { name: 'Close port forwarding dialog' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('closes when the backdrop is clicked while idle', async () => {
    const { container } = renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'New SSH Forward' }));

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    fireEvent.click(container.querySelector('.modal-backdrop') as HTMLElement);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('ignores backdrop clicks while a save is pending', async () => {
    const deferred = createDeferred<void>();
    const onSave = vi.fn().mockReturnValue(deferred.promise);
    const { container } = renderPanel({ onSave });

    fireEvent.click(screen.getByRole('button', { name: 'New SSH Forward' }));
    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'My SSH Rule' } });
    fireEvent.click(container.querySelector('.modal-card__footer .primary-button') as HTMLButtonElement);

    await waitFor(() => {
      expect(onSave).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(container.querySelector('.modal-backdrop') as HTMLElement);

    expect(screen.getByRole('dialog')).toBeInTheDocument();

    deferred.resolve(undefined);

    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });
});
