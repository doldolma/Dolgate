package sshconn

import "errors"

// JumpHopError 는 점프 홉에서 난 실패다.
//
// 문구는 예전 그대로 "jump host: …" 이다(재연결 판정·실패 문구가 그 접두사를 본다). 덧붙는 것은 Depth —
// 대상에서 거꾸로 센 홉 수(1 이면 대상 바로 앞 홉)다. 앱은 이것으로 어느 점프 호스트의 인증이 실패했는지
// 알아, 요청 창을 대상이 아니라 그 홉으로 띄운다. 다단 체인은 홉마다 한 번씩 감싸여 깊이가 쌓인다.
type JumpHopError struct {
	Depth int
	Err   error
}

func (e *JumpHopError) Error() string { return "jump host: " + e.Err.Error() }

func (e *JumpHopError) Unwrap() error { return e.Err }

// wrapJumpHopError 는 점프 호스트로 붙지 못한 오류를 감싼다. 그 홉 자신도 점프를 거쳤다면(안쪽이 이미
// JumpHopError) 한 홉 더 멀다.
func wrapJumpHopError(err error) error {
	var inner *JumpHopError
	if errors.As(err, &inner) {
		return &JumpHopError{Depth: inner.Depth + 1, Err: err}
	}
	return &JumpHopError{Depth: 1, Err: err}
}

// JumpDepth 는 실패가 난 점프 홉의 깊이다. 점프 홉의 실패가 아니면 0.
func JumpDepth(err error) int {
	var hop *JumpHopError
	if errors.As(err, &hop) {
		return hop.Depth
	}
	return 0
}
