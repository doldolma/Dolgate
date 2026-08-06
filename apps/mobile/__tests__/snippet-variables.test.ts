import {
  hasSnippetVariables,
  parseSnippetVariables,
  resolveSnippetCommand,
} from '../src/lib/snippet-variables';

describe('parseSnippetVariables', () => {
  it('등장 순서대로 중복 없이 모은다', () => {
    expect(
      parseSnippetVariables('ssh {{user}}@{{host}} -p {{port}} # {{user}}'),
    ).toEqual([
      { name: 'user', defaultValue: '' },
      { name: 'host', defaultValue: '' },
      { name: 'port', defaultValue: '' },
    ]);
  });

  it('기본값을 읽고, 한쪽에만 있으면 그것을 채택한다', () => {
    expect(parseSnippetVariables('{{host}} {{host=example.com}}')).toEqual([
      { name: 'host', defaultValue: 'example.com' },
    ]);
  });

  it('변수가 없으면 빈 배열', () => {
    expect(parseSnippetVariables('ls -al')).toEqual([]);
  });

  // 회귀 — /g 정규식을 모듈 전역으로 공유하면 lastIndex 가 남아 앞쪽 변수를 통째로 놓친다.
  // 그러면 치환되지 않은 '{{user}}' 가 그대로 셸에 나간다.
  it('연속 호출에서 앞 변수를 놓치지 않는다', () => {
    const command = 'ssh {{user}}@{{host}}';
    expect(hasSnippetVariables(command)).toBe(true);
    expect(parseSnippetVariables(command)).toEqual([
      { name: 'user', defaultValue: '' },
      { name: 'host', defaultValue: '' },
    ]);
    // 여러 번 반복해도 결과가 흔들리면 안 된다.
    for (let index = 0; index < 3; index += 1) {
      expect(parseSnippetVariables(command)).toHaveLength(2);
      expect(hasSnippetVariables(command)).toBe(true);
    }
  });
});

describe('resolveSnippetCommand', () => {
  it('입력값으로 치환한다', () => {
    expect(
      resolveSnippetCommand('ssh {{user}}@{{host}}', {
        user: 'deploy',
        host: 'srv1',
      }),
    ).toBe('ssh deploy@srv1');
  });

  it('값이 없으면 기본값, 기본값도 없으면 빈 문자열', () => {
    expect(resolveSnippetCommand('{{a=alpha}}/{{b}}', {})).toBe('alpha/');
  });

  it('빈 문자열을 준 변수는 기본값으로 되돌리지 않는다', () => {
    // 사용자가 일부러 비운 것이다 — 기본값으로 덮으면 지운 의도가 무시된다.
    expect(resolveSnippetCommand('{{a=alpha}}', { a: '' })).toBe('');
  });

  it('치환 후에도 원본 문자열은 그대로다', () => {
    const command = 'echo {{msg}}';
    resolveSnippetCommand(command, { msg: 'hi' });
    expect(parseSnippetVariables(command)).toEqual([
      { name: 'msg', defaultValue: '' },
    ]);
  });
});
