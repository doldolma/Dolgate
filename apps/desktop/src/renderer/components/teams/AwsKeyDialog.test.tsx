import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appStore } from '../../store/appStore';
import { createEmptyVaultIndex } from '../../store/utils';
import { AwsKeyDialog } from './AwsKeyDialog';

// 이 기기에 키가 없는 팀 정적 AWS 프로필에 키를 넣는 창(M3). 리전은 팀 설정이라 보내지 않는다.

const imports = vi.hoisted(() => ({ updateAwsProfile: vi.fn() }));
vi.mock('../../services/desktop/imports', () => imports);

const MISSING = { teamId: 'team-a', profileId: 'team-prod', profileName: 'acme-prod' };

beforeEach(() => {
  imports.updateAwsProfile.mockReset();
  appStore.setState({
    vaultIndex: {
      ...createEmptyVaultIndex(),
      teams: [{ id: 'team-a', name: 'Acme Infra', role: 'owner', syncState: 'ready', syncError: null, groups: [] }],
    },
  });
});

function renderDialog() {
  const props = { onClose: vi.fn(), onSaved: vi.fn() };
  render(<AwsKeyDialog missing={MISSING} {...props} />);
  return { ...props, dialog: within(screen.getByRole('dialog')) };
}

describe('AwsKeyDialog', () => {
  it('saves only the keys into the team profile, without touching its region', async () => {
    imports.updateAwsProfile.mockResolvedValue(undefined);
    const { dialog, onSaved } = renderDialog();

    expect(dialog.getByRole('heading')).toHaveTextContent('acme-prod · 키');
    expect(dialog.getByRole('heading')).toHaveTextContent('Acme Infra');
    expect(dialog.getByRole('button', { name: '저장' })).toBeDisabled();
    fireEvent.change(dialog.getByLabelText('Access Key'), { target: { value: 'AKIAMINE' } });
    fireEvent.change(dialog.getByLabelText('Secret'), { target: { value: 'mine' } });
    fireEvent.click(dialog.getByRole('button', { name: '저장' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(imports.updateAwsProfile).toHaveBeenCalledWith({
      profileName: 'acme-prod',
      accessKeyId: 'AKIAMINE',
      secretAccessKey: 'mine',
      vaultId: 'team-a',
    });
    expect(imports.updateAwsProfile.mock.calls[0]![0]).not.toHaveProperty('region');
  });

  it('stays open and says why when the keys are refused', async () => {
    imports.updateAwsProfile.mockRejectedValue(new Error('The security token included in the request is invalid.'));
    const { dialog, onSaved, onClose } = renderDialog();

    fireEvent.change(dialog.getByLabelText('Access Key'), { target: { value: 'AKIAWRONG' } });
    fireEvent.change(dialog.getByLabelText('Secret'), { target: { value: 'wrong' } });
    fireEvent.click(dialog.getByRole('button', { name: '저장' }));

    expect(await dialog.findByRole('alert')).toHaveTextContent('The security token included in the request is invalid.');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
