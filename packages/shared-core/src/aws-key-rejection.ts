/**
 * AWS 가 정적 키 자체를 받지 않았다는 오류 코드 — 없는 키(폐기·꺼짐)이거나 비밀 키가 틀렸다.
 *
 * SignatureDoesNotMatch 는 기기 시계가 틀려도 나지만 SDK 가 시계 차이를 고쳐 한 번 더 보낸다 — 끝까지 남은 것만 여기
 * 온다.
 */
const AWS_KEY_REJECTION_CODES = new Set(["InvalidClientTokenId", "SignatureDoesNotMatch"]);

/**
 * AWS 가 이 키를 거절했는가. 문구가 아니라 AWS 오류 코드(SDK 오류의 name)로만 가린다.
 *
 * **데스크톱과 모바일이 같이 쓴다.** 팀 정적 프로필에 이 기기에서 넣은 키가 거절되면 실패 화면이 '키 넣기'를 다시
 * 낸다 — 키가 없을 때와 같은 자리다.
 */
export function isAwsKeyRejectedError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = (error as { name?: unknown }).name;
  return typeof name === "string" && AWS_KEY_REJECTION_CODES.has(name);
}
