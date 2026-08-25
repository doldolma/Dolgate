import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LocalOnlyChromeButton } from './LocalOnlyChromeButton';

describe('LocalOnlyChromeButton', () => {
  // 아이콘 하나로 두면 공유·패널·알림 토글이 늘어선 줄에 섞여 또 하나의 토글로 읽힌다.
  // 글자가 붙어야 눌러 보지 않고도 뜻이 전해진다.
  it('동기화가 꺼졌다고 적힌 칩으로 서고, 누르면 로그인 창을 연다', () => {
    const onRequestLogin = vi.fn();
    render(<LocalOnlyChromeButton onRequestLogin={onRequestLogin} />);

    expect(screen.getByText('동기화 꺼짐')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('동기화 꺼짐'));
    expect(screen.getByTestId('local-only-popover')).toBeInTheDocument();

    // 로그인 자체는 여기서 하지 않는다 — 오류 표시·서버 설정·브라우저 대기를 이 작은 판에
    // 다시 만들면 로그인할 수 있는 자리마다 그것이 복제된다.
    fireEvent.click(screen.getByText('로그인'));
    expect(onRequestLogin).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('local-only-popover')).not.toBeInTheDocument();
  });
});
