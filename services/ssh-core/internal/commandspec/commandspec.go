// Package commandspec serves the terminal autocomplete's command specs — the
// static subcommands and options of `git`, `docker`, `kubectl` and ~700 more —
// to clients that cannot carry them in their own bundle.
//
// **왜 코어가 들고 있는가:** 데스크톱은 Vite 가 스펙마다 청크를 만들어 그 명령을 칠 때만
// 불러온다(renderer/lib/command-spec/store.ts). Metro 에는 그런 길이 없어서 `require` 한 JSON 은
// JS 번들에 그대로 인라인되는데, 스펙 전체는 압축 전 20 MB 다 — 시작 시간으로 낼 수 있는 값이
// 아니다. 반면 이 엔진은 이미 iOS·안드로이드 양쪽에 링크돼 있고, 압축한 채로 들고 있으면
// 1.8 MB 로 끝난다. 푸는 것은 명령 하나를 칠 때 한 번뿐이다.
//
// 스펙 원본은 apps/desktop/src/renderer/generated/command-specs 이고, 여기 있는 것은 그
// 생성기가 함께 찍어 주는 gzip 사본이다(generate-command-specs.cjs).
package commandspec

import (
	"bytes"
	"compress/gzip"
	"embed"
	"encoding/json"
	"io"
	"strings"
	"sync"
)

//go:embed specs
var packed embed.FS

const specDir = "specs"

// maxSpecBytes bounds one decompressed spec. The largest in the catalog is
// under 1 MB; this only stops a corrupt archive from asking for the world.
const maxSpecBytes = 4 << 20

var cache sync.Map // name -> string

// Lookup returns the JSON spec for a command name, or "" when there is none.
//
// 이름은 사용자가 친 명령줄에서 온다 — 그대로 경로에 붙이면 `../` 로 임베드 밖을 가리킬 수
// 있으므로, 스펙 이름이 될 수 있는 글자만 받는다.
func Lookup(name string) string {
	key := strings.TrimSpace(name)
	if !isSpecName(key) {
		return ""
	}
	if hit, ok := cache.Load(key); ok {
		return hit.(string)
	}
	spec := read(key)
	// 없는 이름도 담는다. 스펙이 없는 명령(자체 스크립트 등)을 칠 때마다 임베드를 뒤지지
	// 않으려는 것이다 — 빈 문자열 하나가 그 답이다.
	cache.Store(key, spec)
	return spec
}

var namesOnce sync.Once
var namesJSON string

// Names returns the catalog as a JSON array of command names.
//
// 클라이언트가 이것을 한 번 받아 두면, 스펙이 없는 명령을 칠 때마다 다리를 건너지 않는다 —
// 사용자가 치는 대부분은 스펙이 없는 이름이다(자기 스크립트·별칭).
func Names() string {
	namesOnce.Do(func() {
		entries, err := packed.ReadDir(specDir)
		if err != nil {
			namesJSON = "[]"
			return
		}
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			name := strings.TrimSuffix(entry.Name(), ".json.gz")
			if name != entry.Name() {
				names = append(names, name)
			}
		}
		encoded, err := json.Marshal(names)
		if err != nil {
			namesJSON = "[]"
			return
		}
		namesJSON = string(encoded)
	})
	return namesJSON
}

func read(name string) string {
	file, err := packed.Open(specDir + "/" + name + ".json.gz")
	if err != nil {
		return ""
	}
	defer file.Close()
	reader, err := gzip.NewReader(file)
	if err != nil {
		return ""
	}
	defer reader.Close()
	var out bytes.Buffer
	if _, err := io.Copy(&out, io.LimitReader(reader, maxSpecBytes)); err != nil {
		return ""
	}
	return out.String()
}

// isSpecName accepts the shapes real command names take (`git`, `docker-compose`,
// `python3`, `aws.cmd`) and nothing that could walk out of the embedded tree.
func isSpecName(name string) bool {
	if name == "" || len(name) > 64 {
		return false
	}
	for _, ch := range name {
		switch {
		case ch >= 'a' && ch <= 'z', ch >= 'A' && ch <= 'Z', ch >= '0' && ch <= '9':
		case ch == '-', ch == '_', ch == '.', ch == '+':
		default:
			return false
		}
	}
	// `.` 자체는 허용하지만 경로로 읽힐 수 있는 조합은 막는다.
	return name != "." && name != ".." && !strings.Contains(name, "..")
}
