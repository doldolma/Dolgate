import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NewTabButton } from './NewTabButton';

function sshHost(id: string, label: string) {
  return {
    id,
    kind: 'ssh',
    label,
    hostname: `${id}.example.com`,
    port: 22,
    username: 'ubuntu',
    authType: 'password',
    secretRef: null,
    groupName: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  } as never;
}

function renderButton(overrides: Record<string, unknown> = {}) {
  const props = {
    hosts: [sshHost('h-1', 'alpha'), sshHost('h-2', 'bravo')],
    lastConnectedByHostId: new Map([['h-2', 2_000]]),
    onConnectHost: vi.fn(),
    onOpenLocalTerminal: vi.fn(),
  } as Record<string, unknown>;
  Object.assign(props, overrides);
  render(<NewTabButton {...(props as unknown as Parameters<typeof NewTabButton>[0])} />);
  return props as unknown as {
    onConnectHost: ReturnType<typeof vi.fn>;
    onOpenLocalTerminal: ReturnType<typeof vi.fn>;
  };
}

describe('NewTabButton', () => {
  // 예전에는 새 세션을 열려면 홈으로 돌아가야 했다 — 호스트 검색이 홈에서만 열렸다.
  it('최근 접속한 호스트를 먼저 보여주고, 고르면 연결한다', () => {
    const props = renderButton();

    fireEvent.click(screen.getByLabelText('새 탭'));
    const options = screen.getAllByRole('option');
    // h-2 만 접속 기록이 있으므로 먼저 선다.
    expect(options[0]).toHaveTextContent('bravo');

    fireEvent.click(screen.getByText('bravo'));
    expect(props.onConnectHost).toHaveBeenCalledWith('h-2');
  });

  // 그룹 머리글이 "PALETTE.GROUP.HOST" 로 떴다. 동작만 보는 테스트는 이것을 못 잡는다 —
  // 화면에 실제로 뭐가 적히는지 봐야 한다.
  it('그룹 머리글을 사람이 읽는 말로 적는다', () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('새 탭'));

    expect(screen.getByText('호스트')).toBeInTheDocument();
    expect(screen.getByText('터미널')).toBeInTheDocument();
    expect(screen.queryByText(/palette\.group/i)).not.toBeInTheDocument();
  });

  // 열면 바로 칠 수 있어야 한다. 말풍선이 자리를 잡은 뒤에야 그려지므로 여는 순간에 포커스를
  // 부르면 입력칸이 아직 없어 아무 일도 안 일어난다.
  it('열면 검색칸에 포커스가 간다', () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('새 탭'));

    expect(screen.getByLabelText('호스트 검색')).toHaveFocus();
  });

  // ⌘T 를 눌렀다 취소한 사람이 키보드를 잃으면 안 된다 — 대개 터미널로 돌아가야 한다.
  it('닫으면 열기 전에 있던 곳으로 포커스를 되돌린다', () => {
    const before = document.createElement('textarea');
    document.body.append(before);
    before.focus();
    expect(before).toHaveFocus();

    const { rerender } = render(
      <NewTabButton
        hosts={[sshHost('h-1', 'alpha')]}
        lastConnectedByHostId={new Map()}
        onConnectHost={vi.fn()}
        onOpenLocalTerminal={vi.fn()}
        openSignal={1}
      />,
    );

    fireEvent.click(screen.getByLabelText('새 탭'));
    expect(screen.getByLabelText('호스트 검색')).toHaveFocus();

    // ⌘T 를 다시 누른 것과 같다.
    rerender(
      <NewTabButton
        hosts={[sshHost('h-1', 'alpha')]}
        lastConnectedByHostId={new Map()}
        onConnectHost={vi.fn()}
        onOpenLocalTerminal={vi.fn()}
        openSignal={2}
      />,
    );

    expect(before).toHaveFocus();
    before.remove();
  });

  // 탭이 많아 `+` 가 오른쪽 끝에 있으면 말풍선이 창 밖으로 나간다.
  it('말풍선을 화면 안으로 민다', () => {
    renderButton();
    const button = screen.getByLabelText('새 탭');
    // 창 오른쪽 끝에 있는 버튼.
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      left: 1180,
      right: 1212,
      top: 8,
      bottom: 40,
      width: 32,
      height: 32,
      x: 1180,
      y: 8,
      toJSON: () => ({}),
    } as DOMRect);
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 1200,
    });

    fireEvent.click(button);

    const popover = screen.getByTestId('new-tab-popover');
    // 352(폭) + 8(여백) 을 빼고 남는 자리까지만.
    expect(popover).toHaveStyle({ left: '840px' });
  });

  it('검색하면 이름으로 거른다', () => {
    renderButton();
    fireEvent.click(screen.getByLabelText('새 탭'));
    fireEvent.change(screen.getByLabelText('호스트 검색'), {
      target: { value: 'alp' },
    });

    expect(screen.getByText('alpha')).toBeInTheDocument();
    expect(screen.queryByText('bravo')).not.toBeInTheDocument();
  });

  it('로컬 터미널을 항상 마지막에 둔다', () => {
    const props = renderButton();
    fireEvent.click(screen.getByLabelText('새 탭'));

    const options = screen.getAllByRole('option');
    expect(options[options.length - 1]).toHaveTextContent('로컬 터미널');

    fireEvent.click(screen.getByText('로컬 터미널'));
    expect(props.onOpenLocalTerminal).toHaveBeenCalledTimes(1);
  });

  // ⌘T. 처음 렌더의 값으로는 열지 않는다 — 앱을 켜자마자 말풍선이 떠 있으면 안 된다.
  it('열기 신호가 바뀌면 열리고, 처음 값으로는 열리지 않는다', () => {
    const { rerender } = render(
      <NewTabButton
        hosts={[sshHost('h-1', 'alpha')]}
        lastConnectedByHostId={new Map()}
        onConnectHost={vi.fn()}
        onOpenLocalTerminal={vi.fn()}
        openSignal={3}
      />,
    );
    expect(screen.queryByTestId('new-tab-popover')).not.toBeInTheDocument();

    rerender(
      <NewTabButton
        hosts={[sshHost('h-1', 'alpha')]}
        lastConnectedByHostId={new Map()}
        onConnectHost={vi.fn()}
        onOpenLocalTerminal={vi.fn()}
        openSignal={4}
      />,
    );
    expect(screen.getByTestId('new-tab-popover')).toBeInTheDocument();

    // 같은 키로 닫힌다.
    rerender(
      <NewTabButton
        hosts={[sshHost('h-1', 'alpha')]}
        lastConnectedByHostId={new Map()}
        onConnectHost={vi.fn()}
        onOpenLocalTerminal={vi.fn()}
        openSignal={5}
      />,
    );
    expect(screen.queryByTestId('new-tab-popover')).not.toBeInTheDocument();
  });
});
