// 스니펫 폼은 이제 한 벌이고 두 화면(홈의 스니펫 화면·세션 패널)이 이것을 연다. 그래서 폼의
// 규칙은 여기서만 검증한다.

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SnippetRecord } from '@shared';
import { SnippetEditDialog } from './SnippetEditDialog';

const existing: SnippetRecord = {
  id: 's1',
  label: 'Restart web',
  command: 'systemctl restart web',
  keyword: 'rweb',
} as SnippetRecord;

function saved() {
  return vi.fn().mockResolvedValue(existing);
}

function field(name: string): HTMLInputElement | HTMLTextAreaElement {
  return screen.getByRole(name === 'Snippet command' ? 'textbox' : 'textbox', {
    name,
  }) as HTMLInputElement;
}

describe('SnippetEditDialog', () => {
  it('편집으로 열면 대상의 값이 채워진다', () => {
    render(
      <SnippetEditDialog
        open
        snippet={existing}
        onSave={saved()}
        onClose={vi.fn()}
      />,
    );
    expect(field('Snippet label').value).toBe('Restart web');
    expect(field('Snippet keyword').value).toBe('rweb');
    expect(field('Snippet command').value).toBe('systemctl restart web');
    expect(screen.getByText('스니펫 편집')).toBeTruthy();
  });

  it('새로 만들기로 열면 비어 있다', () => {
    render(
      <SnippetEditDialog open snippet={null} onSave={saved()} onClose={vi.fn()} />,
    );
    expect(field('Snippet label').value).toBe('');
    expect(field('Snippet command').value).toBe('');
    expect(screen.getByText('새 스니펫')).toBeTruthy();
  });

  /**
   * 닫고 다른 스니펫으로 다시 열었을 때 앞서 편집하던 값이 남으면, 그 값을 **다른 스니펫에**
   * 저장하게 된다. 폼 상태를 컴포넌트가 들고 있으므로 열릴 때마다 다시 채워야 한다.
   */
  it('다른 대상으로 다시 열면 값이 갈아진다', () => {
    const other = { ...existing, id: 's2', label: 'Tail log', command: 'tail -f a.log', keyword: null };
    const view = render(
      <SnippetEditDialog open snippet={existing} onSave={saved()} onClose={vi.fn()} />,
    );
    view.rerender(
      <SnippetEditDialog
        open
        snippet={other as SnippetRecord}
        onSave={saved()}
        onClose={vi.fn()}
      />,
    );
    expect(field('Snippet label').value).toBe('Tail log');
    expect(field('Snippet keyword').value).toBe('');
  });

  it('이름이나 명령이 비면 저장하지 않고 이유를 보여 준다', () => {
    const onSave = saved();
    render(
      <SnippetEditDialog open snippet={null} onSave={onSave} onClose={vi.fn()} />,
    );
    fireEvent.change(field('Snippet label'), { target: { value: 'only label' } });
    fireEvent.click(screen.getByRole('button', { name: '추가' }));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('이름과 명령을 모두 입력해 주세요.')).toBeTruthy();
  });

  it('저장하면 다듬은 값을 넘기고 닫는다', async () => {
    const onSave = saved();
    const onClose = vi.fn();
    render(
      <SnippetEditDialog open snippet={null} onSave={onSave} onClose={onClose} />,
    );
    fireEvent.change(field('Snippet label'), { target: { value: '  Deploy  ' } });
    fireEvent.change(field('Snippet command'), { target: { value: 'make deploy' } });
    fireEvent.click(screen.getByRole('button', { name: '추가' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    // 키워드는 비면 null 이다 — 빈 문자열을 저장하면 자동완성이 빈 키워드를 후보로 잡는다.
    expect(onSave).toHaveBeenCalledWith(null, {
      label: 'Deploy',
      command: 'make deploy',
      keyword: null,
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('편집 저장은 대상 id 로 넘어간다', async () => {
    const onSave = saved();
    render(
      <SnippetEditDialog open snippet={existing} onSave={onSave} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith('s1', expect.anything()));
  });

  it('저장이 실패하면 닫지 않고 이유를 남긴다', async () => {
    const onSave = vi.fn().mockRejectedValue(new Error('디스크가 꽉 찼습니다'));
    const onClose = vi.fn();
    render(
      <SnippetEditDialog open snippet={existing} onSave={onSave} onClose={onClose} />,
    );
    fireEvent.click(screen.getByRole('button', { name: '저장' }));
    await waitFor(() => expect(screen.getByText('디스크가 꽉 찼습니다')).toBeTruthy());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('닫혀 있으면 아무것도 그리지 않는다', () => {
    const { container } = render(
      <SnippetEditDialog
        open={false}
        snippet={existing}
        onSave={saved()}
        onClose={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  /**
   * 삭제가 목록 줄이 아니라 여기 있는 이유는 onRemove 주석에 있다. 그 규칙을 여기서 잠근다.
   */
  describe('삭제', () => {
    it('새로 만들 때는 삭제가 없다', () => {
      render(
        <SnippetEditDialog
          open
          snippet={null}
          onSave={saved()}
          onRemove={vi.fn()}
          onClose={vi.fn()}
        />,
      );
      expect(screen.queryByRole('button', { name: '삭제' })).toBeNull();
    });

    it('onRemove 를 주지 않으면 삭제가 없다', () => {
      render(
        <SnippetEditDialog open snippet={existing} onSave={saved()} onClose={vi.fn()} />,
      );
      expect(screen.queryByRole('button', { name: '삭제' })).toBeNull();
    });

    it('확인을 거쳐야 지운다', async () => {
      const onRemove = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();
      render(
        <SnippetEditDialog
          open
          snippet={existing}
          onSave={saved()}
          onRemove={onRemove}
          hostUsageCount={0}
          onClose={onClose}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: '삭제' }));
      expect(onRemove).not.toHaveBeenCalled();

      const confirms = screen.getAllByRole('button', { name: '삭제' });
      fireEvent.click(confirms[confirms.length - 1]);
      await waitFor(() => expect(onRemove).toHaveBeenCalledWith('s1'));
      // 지운 스니펫의 편집 폼을 열어 둘 이유가 없다.
      await waitFor(() => expect(onClose).toHaveBeenCalled());
    });

    it('확인을 취소하면 지우지 않고 폼도 남는다', () => {
      const onRemove = vi.fn().mockResolvedValue(undefined);
      const onClose = vi.fn();
      render(
        <SnippetEditDialog
          open
          snippet={existing}
          onSave={saved()}
          onRemove={onRemove}
          onClose={onClose}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: '삭제' }));
      // 확인 대화상자의 취소(뒤에 그려진 것). 편집 폼의 취소와 이름이 같다.
      const cancels = screen.getAllByRole('button', { name: '취소' });
      fireEvent.click(cancels[cancels.length - 1]);
      expect(onRemove).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      expect(
        (screen.getByRole('textbox', { name: 'Snippet label' }) as HTMLInputElement).value,
      ).toBe('Restart web');
    });

    it('삭제가 실패하면 닫지 않고 이유를 남긴다', async () => {
      const onRemove = vi.fn().mockRejectedValue(new Error('지울 수 없습니다'));
      const onClose = vi.fn();
      render(
        <SnippetEditDialog
          open
          snippet={existing}
          onSave={saved()}
          onRemove={onRemove}
          onClose={onClose}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: '삭제' }));
      const confirms = screen.getAllByRole('button', { name: '삭제' });
      fireEvent.click(confirms[confirms.length - 1]);
      await waitFor(() => expect(screen.getByText('지울 수 없습니다')).toBeTruthy());
      expect(onClose).not.toHaveBeenCalled();
    });

    it('쓰는 호스트 수를 확인에 실어 보낸다', () => {
      render(
        <SnippetEditDialog
          open
          snippet={existing}
          onSave={saved()}
          onRemove={vi.fn()}
          hostUsageCount={3}
          onClose={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: '삭제' }));
      expect(screen.getByText(/호스트 3개의 시작 명령으로 쓰이고 있습니다/)).toBeTruthy();
    });
  });

  it('명령의 변수를 배지로 보여 준다', () => {
    render(
      <SnippetEditDialog open snippet={null} onSave={saved()} onClose={vi.fn()} />,
    );
    fireEvent.change(field('Snippet command'), {
      target: { value: 'ssh {{user}}@{{host=srv1}}' },
    });
    expect(screen.getByText('user')).toBeTruthy();
    expect(screen.getByText('host=srv1')).toBeTruthy();
  });
});
