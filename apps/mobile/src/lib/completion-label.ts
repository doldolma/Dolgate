/**
 * 자동완성 칩에 적을 글자.
 *
 * 데스크톱 오버레이는 줄 전체(`cd Dolgate/`)를 그리고 이미 친 부분을 흐리게 칠해 구분한다.
 * 모바일 칩은 그럴 폭이 없다 — 줄 전체를 적으면 `docker logs …` 앞부분이 칩마다 되풀이된다.
 *
 * 그래서 잘라 쓰되 **낱말 경계**에서 자른다. 예전에는 친 글자 수만큼 잘라내서, `cd Do` 를 친
 * 상태의 `cd Dolgate/` 가 `lgate/` 로 나왔다 — 낱말 중간이 잘려 무엇을 고르는지 읽히지 않는다.
 * 마지막 공백 다음부터 보여주면 `Dolgate/`·`gds2`·`status` 처럼 늘 완결된 낱말이 되고,
 * 앞의 명령은 한 번도 반복되지 않는다.
 */
export function completionLabel(typed: string, insertText: string): string {
  // 친 것을 이어 가는 제안이 아니면(스니펫은 줄 전체를 갈아 끼운다) 자를 기준이 없다.
  if (!insertText.startsWith(typed)) {
    return insertText;
  }
  const boundary = typed.lastIndexOf(' ');
  const start = boundary < 0 ? 0 : boundary + 1;
  return insertText.slice(start) || insertText;
}
