// Snippet 명령에는 {{name}} 또는 {{name=default}} 형태의 변수를 넣을 수 있다.
// 삽입 시 변수 값을 입력받아 치환한다.

export interface SnippetVariable {
  name: string;
  defaultValue: string;
}

// {{ name }} / {{ name=default }} — name은 영숫자/밑줄, default는 } 직전까지.
const SNIPPET_VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_]+)\s*(?:=([^}]*))?\}\}/g;

/**
 * 명령에 등장하는 변수를 등장 순서대로(중복 제거) 반환한다. 같은 변수가 여러 번
 * 나오고 한쪽에만 기본값이 있으면 그 기본값을 채택한다.
 */
export function parseSnippetVariables(command: string): SnippetVariable[] {
  const ordered = new Map<string, SnippetVariable>();
  for (const match of command.matchAll(SNIPPET_VARIABLE_PATTERN)) {
    const name = match[1];
    const defaultValue = (match[2] ?? "").trim();
    const existing = ordered.get(name);
    if (!existing) {
      ordered.set(name, { name, defaultValue });
    } else if (!existing.defaultValue && defaultValue) {
      existing.defaultValue = defaultValue;
    }
  }
  return [...ordered.values()];
}

/** command에 변수가 하나라도 있으면 true. */
export function hasSnippetVariables(command: string): boolean {
  SNIPPET_VARIABLE_PATTERN.lastIndex = 0;
  return SNIPPET_VARIABLE_PATTERN.test(command);
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
    SNIPPET_VARIABLE_PATTERN,
    (_full, name: string, defaultValue?: string) => {
      const provided = values[name];
      if (provided !== undefined) {
        return provided;
      }
      return (defaultValue ?? "").trim();
    },
  );
}
