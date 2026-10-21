import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SnippetRecord, VaultIndex } from '@shared';
import { createEmptyVaultIndex } from '../store/utils';
import { SnippetsPanel } from './SnippetsPanel';

// 4-6: 팀이 있으면 스니펫도 볼트별로 묶고(L2) 묶음의 + 로 그 볼트에 만든다. 편집 창 제목 옆에 볼트 칩.

const TEAM = 'team-1';
const BLOCKED = 'team-blocked';

const snippet = (id: string, label: string, command: string): SnippetRecord => ({
  id,
  label,
  command,
  keyword: null,
  createdAt: 't',
  updatedAt: 't',
});
const snippets = [snippet('p-df', 'Disk usage', 'df -h'), snippet('t-restart', 'Restart app', 'systemctl restart app')];

function vaultIndex(): VaultIndex {
  return {
    ...createEmptyVaultIndex(),
    teams: [
      { id: TEAM, name: 'Acme Infra', role: 'owner', syncState: 'ready', syncError: null, groups: [] },
      { id: BLOCKED, name: 'Old Team', role: 'member', syncState: 'outdated', syncError: null, groups: [] },
    ],
    teamIdBySnippetId: { 't-restart': TEAM },
  };
}

function renderPanel(index: VaultIndex | null = vaultIndex()) {
  const props = {
    onSave: vi.fn(async (id: string | null, draft: { label: string; command: string }) => snippet(id ?? 'new', draft.label, draft.command)),
    onRemove: vi.fn().mockResolvedValue(undefined),
  };
  render(<SnippetsPanel snippets={snippets} hosts={[]} vaultIndex={index} {...props} />);
  return props;
}

const section = (vaultId: string) => document.querySelector<HTMLElement>(`[data-vault-section="${vaultId}"]`)!.parentElement!;

describe('SnippetsPanel vaults', () => {
  it('groups snippets by vault with a + on each and drops New Snippet', () => {
    renderPanel();

    expect(screen.queryByRole('button', { name: 'New Snippet' })).toBeNull();
    expect(within(section('personal')).getByText('Disk usage')).toBeInTheDocument();
    expect(within(section(TEAM)).getByText('Restart app')).toBeInTheDocument();
    expect(within(section(TEAM)).getByRole('button', { name: 'Acme Infra에 스니펫 추가' })).toBeInTheDocument();
    expect(within(section(BLOCKED)).queryByRole('button', { name: /스니펫 추가/ })).toBeNull();
    expect(within(section(BLOCKED)).getByText('아직 저장된 snippet이 없습니다.')).toBeInTheDocument();
  });

  it('creates in the vault whose + was pressed, shown on the dialog', async () => {
    const props = renderPanel();

    fireEvent.click(within(section(TEAM)).getByRole('button', { name: 'Acme Infra에 스니펫 추가' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector(`[data-vault-chip="${TEAM}"]`)).toHaveTextContent('Acme Infra');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Snippet label' }), { target: { value: 'App logs' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Snippet command' }), { target: { value: 'journalctl -u app' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '추가' }));

    await waitFor(() =>
      expect(props.onSave).toHaveBeenCalledWith(null, { label: 'App logs', command: 'journalctl -u app', keyword: null }, TEAM),
    );
  });

  it("edits a team snippet in its own vault — the save carries only its id", async () => {
    const props = renderPanel();

    fireEvent.click(within(section(TEAM)).getByRole('button', { name: '편집' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog.querySelector(`[data-vault-chip="${TEAM}"]`)).not.toBeNull();
    fireEvent.click(within(dialog).getByRole('button', { name: '저장' }));

    await waitFor(() => expect(props.onSave).toHaveBeenCalled());
    expect(props.onSave.mock.calls[0]).toEqual(['t-restart', { label: 'Restart app', command: 'systemctl restart app', keyword: null }]);
  });

  it('shows only the vaults with matches while searching', () => {
    renderPanel();

    fireEvent.change(screen.getByRole('textbox', { name: 'Snippet search' }), { target: { value: 'restart' } });

    expect(document.querySelector('[data-vault-section="personal"]')).toBeNull();
    expect(within(section(TEAM)).getByText('Restart app')).toBeInTheDocument();
  });

  it('stays as it is without teams', () => {
    renderPanel(createEmptyVaultIndex());

    expect(screen.getByRole('button', { name: 'New Snippet' })).toBeInTheDocument();
    expect(document.querySelector('[data-vault-section]')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'New Snippet' }));
    expect(screen.getByRole('dialog').querySelector('[data-vault-chip]')).toBeNull();
  });
});
