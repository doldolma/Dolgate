package sshconn

import "testing"

// applyStoredPassword 는 "어느 칸이 비밀번호인가" 를 우리가 판정하지 않고 사용자가 지목한 자리만
// 채운다. 그 계약을 지키는지 본다 — 지목되지 않은 칸을 건드리면 서버가 두 번째 요소를 묻는 자리에
// 비밀번호를 보내게 되고, 인증 기회는 한 번뿐이라 그걸로 연결이 끝난다.
func TestApplyStoredPassword(t *testing.T) {
	const stored = "s3cret"

	tests := []struct {
		name        string
		responses   []string
		indexes     []int
		promptCount int
		want        []string
	}{
		{
			name:        "지목한 칸만 채운다",
			responses:   []string{"", "123456"},
			indexes:     []int{0},
			promptCount: 2,
			want:        []string{stored, "123456"},
		},
		{
			name:        "지목이 없으면 그대로 보낸다",
			responses:   []string{"typed"},
			promptCount: 1,
			want:        []string{"typed"},
		},
		{
			// 버튼만 누르고 타이핑을 안 하면 그 자리가 비어 있을 수 있다.
			name:        "빈 응답도 자리를 만들어 채운다",
			responses:   nil,
			indexes:     []int{0},
			promptCount: 1,
			want:        []string{stored},
		},
		{
			// 프롬프트 수를 넘겨 보내면 서버가 규격 위반으로 끊는다.
			name:        "프롬프트 수를 넘는 지목은 무시한다",
			responses:   []string{"typed"},
			indexes:     []int{5},
			promptCount: 1,
			want:        []string{"typed"},
		},
		{
			name:        "음수 지목은 무시한다",
			responses:   []string{"typed"},
			indexes:     []int{-1},
			promptCount: 1,
			want:        []string{"typed"},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := ApplyStoredPassword(test.responses, test.indexes, stored, test.promptCount)
			if len(got) != len(test.want) {
				t.Fatalf("응답 개수가 다르다: got %v, want %v", got, test.want)
			}
			for index := range test.want {
				if got[index] != test.want[index] {
					t.Fatalf("%d번 칸이 다르다: got %q, want %q",
						index, got[index], test.want[index])
				}
			}
		})
	}
}

// 저장된 비밀번호가 없으면 지목이 와도 채울 것이 없다. 빈 문자열을 넣어 인증 기회를 날리지 않는다.
func TestApplyStoredPasswordWithoutStoredValue(t *testing.T) {
	got := ApplyStoredPassword([]string{"typed"}, []int{0}, "", 1)

	if len(got) != 1 || got[0] != "typed" {
		t.Fatalf("저장된 값이 없는데 응답을 바꿨다: %v", got)
	}
}
