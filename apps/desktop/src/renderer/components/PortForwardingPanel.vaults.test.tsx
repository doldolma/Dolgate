import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DnsOverrideResolvedRecord, HostRecord, PortForwardRuleRecord, VaultIndex } from '@shared';
import { appStore } from '../store/appStore';
import { createEmptyVaultIndex } from '../store/utils';
import { PortForwardingPanel, resetPortForwardingPanelUiStateForTests } from './PortForwardingPanel';

// 4-6: 팀이 있으면 목록을 볼트별로 묶고(L2), 묶음의 + 로 그 볼트에 만든다. 편집 창은 그 볼트의 호스트·규칙만 보이고
// 머리에 볼트 칩(N2). 같은 이름을 앞 볼트가 적용 중인 DNS 는 "Not applied"(X1). 팀이 없을 때는
// PortForwardingPanel.test.tsx 가 지금 그대로임을 지킨다.

const TEAM = 'team-1';
const BLOCKED = 'team-blocked';
const at = '2025-01-01T00:00:00.000Z';

const ssh = (id: string, label: string, hostname: string): HostRecord =>
  ({ id, kind: 'ssh', label, hostname, port: 22, username: 'ubuntu', authType: 'password', groupName: null, tags: [], createdAt: at, updatedAt: at }) as HostRecord;

const hosts = [ssh('my-web', 'web-1', '203.0.113.11'), ssh('team-web', 'acme-web-1', '10.20.0.11'), ssh('team-db', 'acme-db', '10.20.0.30')];

const rule = (id: string, label: string, hostId: string, bindPort: number): PortForwardRuleRecord => ({
  id,
  transport: 'ssh',
  label,
  hostId,
  mode: 'local',
  bindAddress: '127.0.0.1',
  bindPort,
  targetHost: 'localhost',
  targetPort: 80,
  createdAt: at,
  updatedAt: at,
});

const rules = [rule('my-rule', 'web-1 admin', 'my-web', 8080), rule('team-rule', 'acme-web-1 app', 'team-web', 9000)];

function vaultIndex(): VaultIndex {
  return {
    ...createEmptyVaultIndex(),
    teams: [
      { id: TEAM, name: 'Acme Infra', role: 'owner', syncState: 'ready', syncError: null, groups: [] },
      { id: BLOCKED, name: 'Old Team', role: 'member', syncState: 'needs-rejoin', syncError: null, groups: [] },
    ],
    teamIdByHostId: { 'team-web': TEAM, 'team-db': TEAM },
    teamIdByPortForwardId: { 'team-rule': TEAM },
    teamIdByDnsOverrideId: { 'team-static': TEAM },
  };
}

function renderPanel(options: { dnsOverrides?: DnsOverrideResolvedRecord[] } = {}) {
  const props = {
    hosts,
    containerTabs: [],
    rules,
    dnsOverrides: options.dnsOverrides ?? [],
    runtimes: [],
    interactiveAuth: null,
    discoveryInteractiveAuth: null,
    onSave: vi.fn().mockResolvedValue(undefined),
    onSaveDnsOverride: vi.fn().mockResolvedValue(undefined),
    onSetStaticDnsOverrideActive: vi.fn().mockResolvedValue(undefined),
    onRemove: vi.fn().mockResolvedValue(undefined),
    onRemoveDnsOverride: vi.fn().mockResolvedValue(undefined),
    onStart: vi.fn().mockResolvedValue(undefined),
    onStop: vi.fn().mockResolvedValue(undefined),
    onRespondInteractiveAuth: vi.fn().mockResolvedValue(undefined),
    onReopenInteractiveAuthUrl: vi.fn().mockResolvedValue(undefined),
    onClearInteractiveAuth: vi.fn(),
  };
  // 프로덕션과 같은 배치 — 목록 화면과, 편집기를 그리는 인스턴스(실제로는 PortForwardEditorHost).
  render(
    <>
      <PortForwardingPanel {...props} />
      <PortForwardingPanel {...props} variant="dialog" />
    </>,
  );
  return props;
}

const section = (vaultId: string) => document.querySelector<HTMLElement>(`[data-vault-section="${vaultId}"]`)!.parentElement!;
const hostOptions = async (dialog: HTMLElement) => {
  fireEvent.click(within(dialog).getByRole('button', { name: '호스트' }));
  const listbox = await screen.findByRole('listbox', { name: '호스트 옵션' });
  return within(listbox)
    .getAllByRole('option')
    .map((option) => option.textContent ?? '');
};

beforeEach(() => {
  Object.defineProperty(window, 'dolssh', {
    configurable: true,
    writable: true,
    value: {
      containers: { onConnectionProgress: vi.fn(() => () => undefined), release: vi.fn().mockResolvedValue(undefined) },
      aws: {},
      knownHosts: { probeHost: vi.fn().mockResolvedValue({ status: 'trusted' }) },
    },
  });
  appStore.setState({ vaultIndex: vaultIndex() });
});

afterEach(() => {
  vi.clearAllMocks();
  resetPortForwardingPanelUiStateForTests();
  appStore.setState({ vaultIndex: createEmptyVaultIndex() });
});

describe('PortForwardingPanel vaults', () => {
  it('groups rules by vault with a + on each, and drops the top create button', () => {
    renderPanel();

    expect(screen.queryByRole('button', { name: 'SSH 포워딩 추가' })).toBeNull();
    expect(within(section('personal')).getByText('web-1 admin')).toBeInTheDocument();
    expect(within(section('personal')).queryByText('acme-web-1 app')).toBeNull();
    expect(within(section(TEAM)).getByText('acme-web-1 app')).toBeInTheDocument();
    expect(within(section(TEAM)).getByRole('button', { name: 'Acme Infra에 SSH 포워딩 추가' })).toBeInTheDocument();
    // 막힌 팀에는 만들지 않는다 — 묶음은 있지만 + 가 없고, 비어 있다는 한 줄.
    expect(within(section(BLOCKED)).queryByRole('button', { name: /SSH 포워딩 추가/ })).toBeNull();
    expect(within(section(BLOCKED)).getByText('아직 저장한 SSH 포워딩 규칙이 없습니다.')).toBeInTheDocument();
  });

  it("opens the editor for the vault whose + was pressed: its chip and only its hosts", async () => {
    const props = renderPanel();

    fireEvent.click(within(section(TEAM)).getByRole('button', { name: 'Acme Infra에 SSH 포워딩 추가' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector(`[data-vault-chip="${TEAM}"]`)).toHaveTextContent('Acme Infra');
    // 처음 호스트도 그 볼트 것이다.
    expect(within(dialog).getByRole('button', { name: '호스트' })).toHaveTextContent('acme-web-1');
    const options = await hostOptions(dialog);
    expect(options.some((text) => text.includes('acme-web-1'))).toBe(true);
    expect(options.some((text) => text.includes('acme-db'))).toBe(true);
    expect(options.some((text) => text.includes('web-1') && !text.includes('acme'))).toBe(false);

    fireEvent.pointerDown(within(screen.getByRole('listbox', { name: '호스트 옵션' })).getByText('acme-db'));
    fireEvent.change(within(dialog).getByLabelText('이름'), { target: { value: 'acme-db postgres' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith(null, expect.objectContaining({ label: 'acme-db postgres', hostId: 'team-db' })),
    );
  });

  it("keeps the editor on a team rule's own hosts when editing it", async () => {
    renderPanel();

    fireEvent.click(within(section(TEAM)).getByRole('button', { name: '편집' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector(`[data-vault-chip="${TEAM}"]`)).not.toBeNull();
    const options = await hostOptions(dialog);
    expect(options).toHaveLength(2);
    expect(options.every((text) => text.includes('acme'))).toBe(true);
  });

  it("follows the session's host when the session panel opens it", async () => {
    renderPanel();

    appStore.getState().openPortForwardEditor({ kind: 'create', transport: 'ssh', hostId: 'team-db' });
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector(`[data-vault-chip="${TEAM}"]`)).not.toBeNull();
    expect(within(dialog).getByRole('button', { name: '호스트' })).toHaveTextContent('acme-db');

    fireEvent.click(within(dialog).getByRole('button', { name: '포트 포워딩 창 닫기' }));
    appStore.getState().openPortForwardEditor({ kind: 'create', transport: 'ssh', hostId: 'my-web' });
    const personalDialog = await screen.findByRole('dialog');
    await waitFor(() => expect(personalDialog.querySelector('[data-vault-chip="personal"]')).not.toBeNull());
  });

  it('puts a new static override in the vault whose + was pressed and links only that vault’s rules', async () => {
    const props = renderPanel();
    fireEvent.click(screen.getByRole('tab', { name: 'DNS Override' }));

    fireEvent.click(within(section(TEAM)).getByRole('button', { name: 'Acme Infra에 DNS Override 추가' }));
    const dialog = await screen.findByRole('dialog');
    // Linked 로 열린다 — 이을 규칙은 그 팀 것만.
    const ruleSelect = within(dialog).getAllByRole('combobox').find((select) => select.textContent?.includes('acme-web-1 app'));
    expect(ruleSelect).toBeDefined();
    expect(ruleSelect!.textContent).not.toContain('web-1 admin');

    fireEvent.change(within(dialog).getAllByRole('combobox')[0]!, { target: { value: 'static' } });
    const [hostname, address] = within(dialog).getAllByRole('textbox');
    fireEvent.change(hostname!, { target: { value: 'grafana.lab.test' } });
    fireEvent.change(address!, { target: { value: '10.20.0.50' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));
    await waitFor(() =>
      expect(props.onSaveDnsOverride).toHaveBeenCalledWith(
        null,
        { type: 'static', hostname: 'grafana.lab.test', address: '10.20.0.50' },
        TEAM,
      ),
    );
  });

  it('says a team override is not applied when the personal one with the same name is', () => {
    renderPanel({
      dnsOverrides: [
        { id: 'my-static', type: 'static', hostname: 'grafana.lab.test', address: '10.0.0.20', status: 'active', createdAt: at, updatedAt: at },
        {
          id: 'team-static',
          type: 'static',
          hostname: 'grafana.lab.test',
          address: '10.20.0.50',
          status: 'active',
          appliedByVaultId: 'personal',
          createdAt: at,
          updatedAt: at,
        },
      ],
    });
    fireEvent.click(screen.getByRole('tab', { name: 'DNS Override' }));

    expect(within(section('personal')).getByText('On')).toBeInTheDocument();
    expect(within(section('personal')).queryByText('Not applied')).toBeNull();
    expect(within(section(TEAM)).getByText('Not applied')).toBeInTheDocument();
    expect(within(section(TEAM)).getByRole('img', { name: '같은 이름을 Personal 것이 적용하고 있습니다' })).toBeInTheDocument();
    // 켜 둔 그대로라 끄기 단추가 남는다.
    expect(within(section(TEAM)).getByRole('button', { name: 'Off' })).toBeInTheDocument();
  });

  it("edits a team override in the team's own vault", async () => {
    renderPanel({
      dnsOverrides: [
        { id: 'team-static', type: 'static', hostname: 'grafana.lab.test', address: '10.20.0.50', status: 'inactive', createdAt: at, updatedAt: at },
      ],
    });
    fireEvent.click(screen.getByRole('tab', { name: 'DNS Override' }));

    fireEvent.click(within(section(TEAM)).getByRole('button', { name: '편집' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector(`[data-vault-chip="${TEAM}"]`)).not.toBeNull();
  });
});
