package tmuxsession

import "testing"

func TestParsePaneState(t *testing.T) {
	cases := []struct {
		name string
		out  string
		want paneState
	}{
		{
			name: "프롬프트의 bash",
			out:  "bash\t0\t0\t\t17\t3\t101\t52\n",
			want: paneState{command: "bash", cursorX: 17, cursorY: 3, width: 101, height: 52, known: true},
		},
		{
			name: "대체화면(htop)",
			out:  "htop\t1\t0\t\t17\t3\t101\t52\n",
			want: paneState{command: "htop", alternateOn: true, cursorX: 17, cursorY: 3, width: 101, height: 52, known: true},
		},
		{
			name: "tmux copy mode",
			out:  "bash\t0\t1\t\t17\t3\t101\t52\n",
			want: paneState{command: "bash", inMode: true, cursorX: 17, cursorY: 3, width: 101, height: 52, known: true},
		},
		{
			// pane_in_mode 는 불리언이 아니라 활성 모드 개수다(tmux 는 모드를 큐에 쌓는다).
			name: "모드가 중첩됨",
			out:  "bash\t0\t2\t\t17\t3\t101\t52\n",
			want: paneState{command: "bash", inMode: true, cursorX: 17, cursorY: 3, width: 101, height: 52, known: true},
		},
		{
			name: "줄바꿈 없는 답",
			out:  "zsh\t0\t0\t\t17\t3\t101\t52",
			want: paneState{command: "zsh", cursorX: 17, cursorY: 3, width: 101, height: 52, known: true},
		},
		{
			name: "CRLF",
			out:  "fish\t0\t0\t\t17\t3\t101\t52\r\n",
			want: paneState{command: "fish", cursorX: 17, cursorY: 3, width: 101, height: 52, known: true},
		},
		{
			// 포맷 이름을 모르는 구버전 tmux 는 에러가 아니라 빈 확장을 준다.
			name: "포맷을 모르는 tmux",
			out:  "bash\t\t\t\t17\t3\t101\t52\n",
			want: paneState{command: "bash", cursorX: 17, cursorY: 3, width: 101, height: 52, known: true},
		},
		{
			// tmux 가 알려준 "심고 마커까지 확인했다" 표식(pane 옵션). 재연결에서 이걸 보면 다시 안 심는다.
			name: "이미 심어진 pane",
			out:  "bash\t0\t0\t2\t17\t3\t101\t52\n",
			want: paneState{command: "bash", integrated: true, cursorX: 17, cursorY: 3, width: 101, height: 52, known: true},
		},
		{
			// 옛 코드가 확인 없이 남긴 1 — 깨진 설치일 수 있다. 심어지지 않은 것으로 봐서 한 번 다시 심는다.
			name: "옛 표식 1 은 무효",
			out:  "bash\t0\t0\t1\t17\t3\t101\t52\n",
			want: paneState{command: "bash", integrated: false, cursorX: 17, cursorY: 3, width: 101, height: 52, known: true},
		},
		{
			name: "필드가 모자란 답",
			out:  "bash\t0\t0\n",
			want: paneState{},
		},
		{
			name: "빈 답",
			out:  "",
			want: paneState{},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parsePaneState([]byte(tc.out)); got != tc.want {
				t.Errorf("parsePaneState(%q) = %+v, want %+v", tc.out, got, tc.want)
			}
		})
	}
}

func TestPaneStateShellAtPrompt(t *testing.T) {
	cases := []struct {
		name  string
		state paneState
		want  string
	}{
		{"bash", paneState{command: "bash", cursorX: 17, cursorY: 3, width: 101, height: 52, known: true}, "bash"},
		{"로그인 셸(-bash)", paneState{command: "-bash", cursorX: 17, cursorY: 3, width: 101, height: 52, known: true}, "bash"},
		{"절대경로", paneState{command: "/usr/bin/zsh", cursorX: 17, cursorY: 3, width: 101, height: 52, known: true}, "zsh"},
		// 여기가 이 변경의 핵심이다: 이 셋 중 하나라도 놓치면 사용자가 편집 중인
		// 파일이나 화면에 프로브 한 줄이 들어간다.
		{"vi 가 떠 있음", paneState{command: "vi", cursorX: 17, cursorY: 3, width: 101, height: 52, known: true}, ""},
		{"htop 이 떠 있음", paneState{command: "htop", alternateOn: true, cursorX: 17, cursorY: 3, width: 101, height: 52, known: true}, ""},
		{"대체화면인데 이름은 셸", paneState{command: "bash", alternateOn: true, cursorX: 17, cursorY: 3, width: 101, height: 52, known: true}, ""},
		{"copy mode", paneState{command: "bash", inMode: true, cursorX: 17, cursorY: 3, width: 101, height: 52, known: true}, ""},
		{"물어보지 못했다", paneState{command: "bash"}, ""},
		// 분할 직후: bash 는 떴지만 프롬프트를 아직 안 그렸다(커서 0,0). 지금 타이핑하면 tty 에코와
		// readline 재에코가 둘 다 남는다(실기기 %143) — 안착 게이트에 맡긴다.
		{"프롬프트를 아직 안 그림", paneState{command: "bash", cursorX: 0, known: true}, ""},
		// 통합을 넣을 수 없는 셸은 예전부터 거절해 왔다(dash pane 오염).
		{"dash", paneState{command: "dash", cursorX: 17, cursorY: 3, width: 101, height: 52, known: true}, ""},
		{"sudo 진행 중", paneState{command: "sudo", cursorX: 17, cursorY: 3, width: 101, height: 52, known: true}, ""},
		{"빈 이름", paneState{command: "", cursorX: 17, cursorY: 3, width: 101, height: 52, known: true}, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.state.shellAtPrompt(); got != tc.want {
				t.Errorf("shellAtPrompt(%+v) = %q, want %q", tc.state, got, tc.want)
			}
		})
	}
}

func TestPaneFlagSet(t *testing.T) {
	for _, on := range []string{"1", "2", "10"} {
		if !paneFlagSet(on) {
			t.Errorf("paneFlagSet(%q) = false, want true", on)
		}
	}
	for _, off := range []string{"0", "", " ", "\t"} {
		if paneFlagSet(off) {
			t.Errorf("paneFlagSet(%q) = true, want false", off)
		}
	}
}

func TestIsPaneID(t *testing.T) {
	valid := []string{"%0", "%5", "%123"}
	for _, id := range valid {
		if !isPaneID(id) {
			t.Errorf("isPaneID(%q) = false, want true", id)
		}
	}
	// pane id 는 셸 명령의 인용부호 안으로 들어간다 — tmux 가 준 모양이 아니면 조회하지 않는다.
	invalid := []string{"", "%", "5", "@0", "%a", "%1a", "%1 ", "%0'; id #", "$0"}
	for _, id := range invalid {
		if isPaneID(id) {
			t.Errorf("isPaneID(%q) = true, want false", id)
		}
	}
}
