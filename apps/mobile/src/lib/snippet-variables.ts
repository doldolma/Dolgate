// 스니펫 명령의 {{name}} / {{name=default}} 변수를 다룬다.
//
// 데스크톱 renderer/lib/snippet.ts 와 같은 규격이다. shared-core 로 올리지 않고 복제한 것은
// 의도된 것이다 — 데스크톱 렌더러가 shared-core 에서 **값**을 import 하면 vite dev 의 export*
// 누락으로 화면이 통째로 비는 문제가 있어, 저장소 전체가 그 경계에서 값을 인라인해 쓴다
// (HostForm.tsx·AiSettingsPanel.tsx·SettingsPanel.tsx 에 같은 사유가 적혀 있다).
// 30 줄 남짓의 순수 함수라 중복이 더 싸다.

export interface SnippetVariable {
  name: string;
  defaultValue: string;
}

// {{ name }} / {{ name=default }} — name 은 영숫자·밑줄, default 는 } 직전까지.
//
// 정규식 객체를 모듈 전역으로 공유하지 않고 매번 새로 만든다. /g 정규식은 test()·exec() 가
// lastIndex 를 남기고 matchAll 은 그 값을 복제해 가므로(spec: matcher.lastIndex = R.lastIndex),
// 공유하면 호출 순서에 따라 앞쪽 변수를 통째로 놓친다 — hasSnippetVariables('ssh {{user}}@{{host}}')
// 뒤에 parseSnippetVariables 를 부르면 user 가 빠진 채 반환되고, 그 변수는 치환되지 않은
// '{{user}}' 그대로 셸에 나간다.
const SNIPPET_VARIABLE_SOURCE = String.raw`\{\{\s*([A-Za-z0-9_]+)\s*(?:=([^}]*))?\}\}`;

function snippetVariablePattern(): RegExp {
  return new RegExp(SNIPPET_VARIABLE_SOURCE, 'g');
}

/**
 * 명령에 등장하는 변수를 등장 순서대로(중복 제거) 반환한다. 같은 변수가 여러 번 나오고
 * 한쪽에만 기본값이 있으면 그 기본값을 채택한다.
 */
export function parseSnippetVariables(command: string): SnippetVariable[] {
  const ordered = new Map<string, SnippetVariable>();
  for (const match of command.matchAll(snippetVariablePattern())) {
    const name = match[1];
    const defaultValue = (match[2] ?? '').trim();
    const existing = ordered.get(name);
    if (!existing) {
      ordered.set(name, { name, defaultValue });
    } else if (!existing.defaultValue && defaultValue) {
      existing.defaultValue = defaultValue;
    }
  }
  return [...ordered.values()];
}

/** command 에 변수가 하나라도 있으면 true. */
export function hasSnippetVariables(command: string): boolean {
  // 존재 여부만 보면 되므로 /g 없이 — 상태가 남지 않는다.
  return new RegExp(SNIPPET_VARIABLE_SOURCE).test(command);
}

/**
 * 변수를 입력값으로 치환한다. 값이 주어지지 않은(undefined) 변수는 기본값으로,
 * 기본값도 없으면 빈 문자열로 치환한다.
 */
export function resolveSnippetCommand(
  command: string,
  values: Record<string, string>,
): string {
  return command.replace(
    snippetVariablePattern(),
    (_full, name: string, defaultValue?: string) => {
      const provided = values[name];
      if (provided !== undefined) {
        return provided;
      }
      return (defaultValue ?? '').trim();
    },
  );
}
