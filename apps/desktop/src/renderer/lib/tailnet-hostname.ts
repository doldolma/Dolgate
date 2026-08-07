/**
 * tailnet 노드 이름(이 기기가 tailnet 에 등록할 때 쓰는 이름)을 다듬는다.
 *
 * 컨트롤 플레인은 이 값을 DNS 라벨로 만들어 쓰기 때문에, 아무 문자열이나 넣으면 조용히
 * 다른 이름으로 등록된다(tailscale 의 SanitizeLabel). 사용자가 입력한 것과 기기 목록에
 * 보이는 것이 다르면 그 자체로 버그처럼 보이므로, 같은 규칙을 여기서 먼저 적용해
 * "이렇게 등록된다"를 미리 보여 준다.
 *
 * 규칙(tailscale util/dnsname 과 동일):
 *   - 영숫자로 시작하고 영숫자로 끝난다
 *   - 가운데의 구분자(공백, `.`, `_`, `-` 등)는 하이픈 하나로
 *   - 63자를 넘지 않는다
 */

const MAX_LABEL_LENGTH = 63;

function isAlphanumeric(ch: string): boolean {
  return /[a-zA-Z0-9]/.test(ch);
}

function isSeparator(ch: string): boolean {
  // tailscale 이 하이픈으로 바꿔 주는 문자들.
  return ch === ' ' || ch === '.' || ch === '_' || ch === '@' || ch === '-';
}

/**
 * 입력을 실제로 등록될 이름으로 바꾼다. 남는 것이 없으면 빈 문자열 — 호출부는 그때
 * "기본값을 쓴다"로 해석한다.
 */
export function normalizeTailnetHostname(input: string): string {
  const label = input.trim().slice(0, MAX_LABEL_LENGTH);

  let start = 0;
  let end = label.length;
  while (start < end && !isAlphanumeric(label[start])) {
    start += 1;
  }
  while (start < end && !isAlphanumeric(label[end - 1])) {
    end -= 1;
  }

  let out = '';
  for (let index = start; index < end; index += 1) {
    const ch = label[index];
    if (isAlphanumeric(ch)) {
      out += ch;
      continue;
    }
    if (isSeparator(ch)) {
      // 연속된 구분자가 하이픈 여러 개가 되지 않게 한다.
      if (!out.endsWith('-')) {
        out += '-';
      }
      continue;
    }
    // 그 밖의 문자(한글·기호 등)는 버린다. tailscale 도 남기지 않는다.
  }
  // 앞뒤 다듬기를 먼저 했어도, 버려진 문자 때문에 끝에 하이픈이 남을 수 있다.
  while (out.endsWith('-')) {
    out = out.slice(0, -1);
  }
  return out;
}

/** 입력한 그대로 등록되는지. 다르면 화면이 "이렇게 등록됩니다"를 보여 준다. */
export function isTailnetHostnameExact(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.length > 0 && normalizeTailnetHostname(trimmed) === trimmed;
}
