package runtime

import (
	"testing"

	"dolssh/services/ssh-core/pkg/coretypes"
)

// SSM 셸도 서브셸(`bash`·`sudo su`·`docker exec`)에 들어가면 훅을 잃는다. 매니저에는 구현이
// 있었는데 이 디스패치에 분기가 없어 조용히 아무 일도 하지 않았다 — 오류도 안 났다(`return
// nil`). 그 사이 모바일은 같은 구현을 쓰고 있었고, 데스크톱에서만 SSM 셸의 서브셸 통합이
// 통째로 빠져 있었다.
func TestReinjectShellIntegrationReachesAwsSessions(t *testing.T) {
	aws := &stubAWSManager{hasSession: true}
	core := newRuntimeWithDeps(
		func(coretypes.Event) {},
		func(coretypes.StreamFrame, []byte) {},
		&stubSSHManager{},
		&stubMoshManager{},
		aws,
		&stubLocalManager{},
		&stubSerialManager{},
		&stubSFTPService{},
		&stubContainersService{},
		&stubForwardingService{},
		&stubSSMForwardingService{},
		nil,
		nil,
	)

	if err := core.ReinjectShellIntegration("session-1", "bash"); err != nil {
		t.Fatalf("ReinjectShellIntegration() error = %v", err)
	}
	if aws.reinjectCount != 1 {
		t.Fatalf("AWS 매니저까지 가야 한다: %d 회 호출", aws.reinjectCount)
	}
	if aws.reinjectedShell != "bash" {
		t.Fatalf("셸 힌트를 그대로 넘겨야 한다: %q", aws.reinjectedShell)
	}
}

// 아는 세션이 없으면 조용히 넘어간다 — 여기서 오류를 올리면 터미널이 내려간다.
func TestReinjectShellIntegrationIsNoOpForUnknownSessions(t *testing.T) {
	aws := &stubAWSManager{}
	core := newRuntimeWithDeps(
		func(coretypes.Event) {},
		func(coretypes.StreamFrame, []byte) {},
		&stubSSHManager{},
		&stubMoshManager{},
		aws,
		&stubLocalManager{},
		&stubSerialManager{},
		&stubSFTPService{},
		&stubContainersService{},
		&stubForwardingService{},
		&stubSSMForwardingService{},
		nil,
		nil,
	)

	if err := core.ReinjectShellIntegration("nobody", "bash"); err != nil {
		t.Fatalf("모르는 세션은 조용히 넘어가야 한다: %v", err)
	}
	if aws.reinjectCount != 0 {
		t.Fatalf("부르지 않아야 한다: %d", aws.reinjectCount)
	}
}
