package commandspec

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestLookupReturnsAUsableSpec(t *testing.T) {
	raw := Lookup("git")
	if raw == "" {
		t.Fatal("git 스펙이 없다 — 임베드가 비었을 수 있다")
	}
	var spec struct {
		Name        string `json:"name"`
		Subcommands []struct {
			Name string `json:"name"`
		} `json:"subcommands"`
	}
	if err := json.Unmarshal([]byte(raw), &spec); err != nil {
		t.Fatalf("스펙이 JSON 이 아니다: %v", err)
	}
	if len(spec.Subcommands) == 0 {
		t.Fatal("서브커맨드가 하나도 없다 — 자동완성이 쓸 것이 없다")
	}
}

func TestLookupIsEmptyForUnknownCommands(t *testing.T) {
	if got := Lookup("dolgate-not-a-real-command"); got != "" {
		t.Fatalf("모르는 명령에 답이 왔다: %q", got[:min(40, len(got))])
	}
}

// 이름은 사용자가 친 명령줄에서 온다. 그대로 경로에 붙이면 임베드 밖을 가리킬 수 있다.
func TestLookupRefusesNamesThatCouldWalkOutOfTheTree(t *testing.T) {
	for _, name := range []string{
		"../commandspec", "../../go.mod", "specs/../../go.mod",
		"git/../git", "..", ".", "", strings.Repeat("a", 65),
		"git\x00", "git spec", "git;ls",
	} {
		if got := Lookup(name); got != "" {
			t.Fatalf("%q 를 받아 줬다", name)
		}
	}
}

// 같은 이름을 여러 번 쳐도 임베드를 다시 풀지 않는다.
func TestLookupCachesBothHitsAndMisses(t *testing.T) {
	first := Lookup("docker")
	if first == "" {
		t.Skip("docker 스펙이 카탈로그에 없다")
	}
	if second := Lookup("docker"); second != first {
		t.Fatal("같은 이름인데 다른 답이 왔다")
	}
	if _, ok := cache.Load("dolgate-missing"); ok {
		t.Fatal("아직 묻지도 않은 이름이 캐시에 있다")
	}
	Lookup("dolgate-missing")
	value, ok := cache.Load("dolgate-missing")
	if !ok || value.(string) != "" {
		t.Fatal("없다는 답이 캐시되지 않았다")
	}
}

// 목록을 한 번 받아 두면 스펙 없는 이름에 다리를 건너지 않는다.
func TestNamesListsTheCatalog(t *testing.T) {
	var names []string
	if err := json.Unmarshal([]byte(Names()), &names); err != nil {
		t.Fatalf("목록이 JSON 배열이 아니다: %v", err)
	}
	if len(names) < 100 {
		t.Fatalf("카탈로그가 너무 작다: %d개", len(names))
	}
	has := func(want string) bool {
		for _, name := range names {
			if name == want {
				return true
			}
		}
		return false
	}
	if !has("git") {
		t.Fatal("git 이 목록에 없다")
	}
	// 확장자가 남아 있으면 클라이언트의 이름 대조가 전부 빗나간다.
	for _, name := range names {
		if strings.Contains(name, ".gz") || strings.Contains(name, ".json") {
			t.Fatalf("이름에 확장자가 남았다: %q", name)
		}
	}
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
