import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { VaultChip, VaultMark, VaultSectionHeader } from './VaultMark';

// 볼트 표시는 선 아이콘이다(개인은 사람, 팀은 사람들) — 머리글자 네모는 없앴다. 이름이 바로 옆에 있는 묶음 머리·편집 창
// 칩에는 표시를 달지 않는다(볼트가 섞여 보이는 곳에만 단다).
describe('vault marks', () => {
  it('draws a person for the personal vault and people for a team, with no letters', () => {
    const { container, rerender } = render(<VaultMark kind="personal" />);
    expect(container.querySelector('svg.lucide-user')).not.toBeNull();
    expect(container.textContent).toBe('');

    rerender(<VaultMark kind="team" size="xs" />);
    expect(container.querySelector('svg.lucide-users')).not.toBeNull();
    expect(container.textContent).toBe('');
  });

  it('leaves the mark out where the name sits right beside it', () => {
    const team = { id: 'team-1', name: 'Acme Infra' };
    const { container } = render(
      <>
        <VaultSectionHeader team={team} count={3} addLabel={null} />
        <VaultChip team={team} />
      </>,
    );

    expect(container.querySelector('[data-vault-section] svg')).toBeNull();
    expect(container.querySelector('[data-vault-chip] svg')).toBeNull();
    expect(container.querySelector('[data-vault-chip]')?.textContent).toBe('Acme Infra');
  });
});
