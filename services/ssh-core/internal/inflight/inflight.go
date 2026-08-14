// Package inflight 는 "진행 중인 작업" 을 키로 들고 있다가 취소할 수 있게 한다.
//
// **왜 필요한가:** 연결을 시작하는 핸들러들(포워딩 시작, SFTP·컨테이너 연결, 세션 연결)은 dial 과
// 핸드셰이크에서 오래 기다릴 수 있다 — TCP 타임아웃, 응답하지 않는 서버, tailnet 노드 기동. 그동안
// 사용자가 정지·연결 종료를 눌러도 예전에는 그 작업을 끊을 방법이 없었다(dial 이 취소 불가한
// context.Background() 로 돌았다).
//
// 사람의 답을 기다리는 구간은 각 서비스가 이미 대기표를 닫아 풀어 준다. 여기서 다루는 것은 그
// 나머지, **기계를 기다리는 구간**이다.
package inflight

import (
	"context"
	"sync"
)

// Registry 는 키(규칙·엔드포인트·세션 ID)마다 진행 중 작업의 취소 함수를 보관한다.
//
// 한 키에 여러 개가 겹칠 수 있게 목록으로 든다. 라우터가 같은 대상의 명령을 한 줄로 세우므로 보통은
// 하나지만, 겹쳤을 때 서로의 등록을 지워 취소가 조용히 사라지는 일은 없어야 한다.
type Registry struct {
	mu      sync.Mutex
	seq     int
	entries map[string][]entry
}

type entry struct {
	id     int
	cancel context.CancelFunc
}

func New() *Registry {
	return &Registry{entries: make(map[string][]entry)}
}

// Begin 은 이 키의 작업을 등록하고, 그 작업에 넘길 ctx 와 끝났을 때 부를 정리 함수를 돌려준다.
//
// 정리 함수는 등록을 지우고 ctx 를 취소한다. 연결이 성립한 뒤 취소해도 안전하다 — DialClient 은
// 핸드셰이크가 끝나면 ctx 감시를 끄기 때문에(sshconn 참고) 성립한 연결이 닫히지 않는다.
func (registry *Registry) Begin(key string) (context.Context, func()) {
	ctx, cancel := context.WithCancel(context.Background())

	registry.mu.Lock()
	registry.seq += 1
	id := registry.seq
	registry.entries[key] = append(registry.entries[key], entry{id: id, cancel: cancel})
	registry.mu.Unlock()

	return ctx, func() {
		registry.mu.Lock()
		remaining := registry.entries[key][:0]
		for _, existing := range registry.entries[key] {
			if existing.id != id {
				remaining = append(remaining, existing)
			}
		}
		if len(remaining) == 0 {
			delete(registry.entries, key)
		} else {
			registry.entries[key] = remaining
		}
		registry.mu.Unlock()
		cancel()
	}
}

// Cancel 은 그 키로 진행 중인 작업을 끊는다. 없으면 아무 일도 하지 않는다(이미 끝났다는 뜻).
func (registry *Registry) Cancel(key string) {
	registry.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(registry.entries[key]))
	for _, existing := range registry.entries[key] {
		cancels = append(cancels, existing.cancel)
	}
	delete(registry.entries, key)
	registry.mu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}
}

// Has 는 그 키로 진행 중인 작업이 있는지다. 테스트가 "붙는 중" 을 기다릴 때 쓴다.
func (registry *Registry) Has(key string) bool {
	registry.mu.Lock()
	defer registry.mu.Unlock()
	return len(registry.entries[key]) > 0
}

// CancelAll 은 전부 끊는다(코어 종료).
func (registry *Registry) CancelAll() {
	registry.mu.Lock()
	cancels := make([]context.CancelFunc, 0, len(registry.entries))
	for key, existing := range registry.entries {
		for _, item := range existing {
			cancels = append(cancels, item.cancel)
		}
		delete(registry.entries, key)
	}
	registry.mu.Unlock()

	for _, cancel := range cancels {
		cancel()
	}
}
