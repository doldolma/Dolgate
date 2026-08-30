import { completionLabel } from '../src/lib/completion-label';

// 칩은 좁아서 줄 전체를 담지 못한다. 그렇다고 친 글자 수만큼 잘라내면 낱말 중간이 잘려
// `cd Do` + `cd Dolgate/` 가 `lgate/` 로 나온다 — 무엇을 고르는지 읽히지 않는다.
describe('자동완성 칩 글자', () => {
  it('치고 있는 낱말을 통째로 보여준다', () => {
    expect(completionLabel('cd Do', 'cd Dolgate/')).toBe('Dolgate/');
    expect(completionLabel('git s', 'git status')).toBe('status');
  });

  it('낱말을 아직 시작하지 않았으면 그 자리에 들어갈 값만 보여준다', () => {
    expect(completionLabel('docker logs ', 'docker logs gds2')).toBe('gds2');
  });

  it('첫 낱말을 치는 중이면 명령 이름 전체가 나온다', () => {
    expect(completionLabel('gi', 'git status')).toBe('git status');
    expect(completionLabel('', 'git status')).toBe('git status');
  });

  // 스니펫은 친 것을 잇지 않고 줄 전체를 갈아 끼운다 — 자를 기준이 없다.
  it('친 것을 잇지 않는 제안은 통째로 보여준다', () => {
    expect(completionLabel('deploy', 'kubectl rollout restart deploy/api')).toBe(
      'kubectl rollout restart deploy/api',
    );
  });
});
