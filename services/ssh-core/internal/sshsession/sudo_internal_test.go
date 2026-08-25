package sshsession

import "testing"

// 되물릴 비밀번호는 **비밀번호로 붙은 세션에만** 남긴다. 키·에이전트로 붙었으면 우리가 들고
// 있는 값이 sudo 비밀번호일 이유가 없고, 그걸로 시도하면 헛되이 실패 카운터만 올린다.
func TestSudoPasswordIsKeptOnlyForPasswordAuth(t *testing.T) {
	for _, testCase := range []struct {
		name     string
		authType string
		password string
		want     string
	}{
		{name: "password auth", authType: "password", password: "s3cr3t", want: "s3cr3t"},
		{name: "key auth", authType: "privateKey", password: "s3cr3t", want: ""},
		{name: "agent auth", authType: "agent", password: "s3cr3t", want: ""},
		{name: "password auth with no password", authType: "password", want: ""},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			handle := &sessionHandle{}
			handle.setSudoPassword(testCase.authType, testCase.password)
			if got := handle.takeSudoPassword(); got != testCase.want {
				t.Fatalf("takeSudoPassword() = %q, want %q", got, testCase.want)
			}
		})
	}
}

// 한 번 거절당하면 그 세션에서는 다시 내밀지 않는다. 틀린 sudo 시도는 pam_faillock 카운터를
// 올려 계정을 잠그므로, 주기적으로 재시도하는 것이 실제 피해가 된다.
func TestSudoIsNotRetriedAfterOneRefusal(t *testing.T) {
	handle := &sessionHandle{}
	handle.setSudoPassword("password", "s3cr3t")
	if handle.takeSudoPassword() == "" {
		t.Fatal("first attempt must be allowed")
	}
	handle.denySudo()
	if got := handle.takeSudoPassword(); got != "" {
		t.Fatalf("takeSudoPassword() = %q after a refusal, want %q", got, "")
	}
}
