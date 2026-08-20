import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { HostEditSwitchConfirmDialog } from './HostEditSwitchConfirmDialog';

describe('HostEditSwitchConfirmDialog', () => {
  // 지나가다 뜨는 창이라 선택지는 둘이다 — 취소(머문다) 아니면 저장(저장하고 이동). 버리고 싶으면
  // 편집기를 X 로 닫는 길이 이미 화면에 있다.
  it('asks with two choices only', () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();

    render(
      <HostEditSwitchConfirmDialog
        open
        isSaving={false}
        onCancel={onCancel}
        onSave={onSave}
      />,
    );

    expect(screen.getByText('저장하지 않은 변경사항이 있습니다')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    expect(onSave).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: '취소' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('locks both buttons while the save is in flight', () => {
    render(
      <HostEditSwitchConfirmDialog
        open
        isSaving
        onCancel={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByRole('button', { name: '저장' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '취소' })).toBeDisabled();
  });

  it('shows a failed save in place instead of closing silently', () => {
    render(
      <HostEditSwitchConfirmDialog
        open
        isSaving={false}
        errorMessage="호스트를 저장하지 못했습니다."
        onCancel={vi.fn()}
        onSave={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText('호스트를 저장하지 못했습니다.')).toBeInTheDocument();
  });
});
