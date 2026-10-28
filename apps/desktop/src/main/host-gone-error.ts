/**
 * 붙는 사이 호스트가 볼트에서 사라져(팀에서 빠짐·지움) 앱이 그 연결을 멈췄다. 메시지는 화면에 그대로 보일 까닭이다 —
 * 단계 정보를 붙이거나 다른 길(SSM 셸 등)로 물러나지 않는다.
 *
 * 이름(`name`)은 바꾸지 않는다. IPC 를 건너면 `Error invoking remote method '…': <이름>: <문구>` 로 가는데 화면은 'Error: '만
 * 벗긴다 — 이름을 바꾸면 그 이름이 문구 앞에 남는다. 메인은 이 오류를 클래스(`instanceof`)로만 가린다.
 */
export class HostGoneError extends Error {}
