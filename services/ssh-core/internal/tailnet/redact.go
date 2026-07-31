package tailnet

import "strings"

// 컨트롤 플레인은 키가 틀렸다는 오류에 **키 자체를 실어** 돌려준다.
//
//	"invalid key: API key k66ACdUAcB11CNTRL not valid"
//
// 그 문장은 상태로 화면까지 올라가고 로그·스크린샷에도 남는다. 코어 밖으로 나가기 전에 가린다 —
// 키를 화면으로 내려보내지 않는다는 규칙과 같은 방향이다.
//
// 앞은 남긴다. 전부 가리면 여러 tailnet 을 쓰는 사람이 어느 키가 문제인지 알 수 없다.
const (
	secretKeepPrefix = 4
	secretMask       = "***"
	// minSecretRun 은 이보다 짧은 토큰은 키 조각으로 보지 않는 길이다. 짧게 잡으면 "key" 나
	// "api" 같은 흔한 낱말이 키의 부분 문자열이라는 이유로 가려진다.
	minSecretRun = 8
)

// redactAuthKey 는 문장에서 auth key 와 그 조각을 가린다.
//
// 조각까지 보는 이유: 서버는 키 전체가 아니라 키 ID 부분만 돌려주기도 한다(위 예시의
// "k66ACdUAcB11CNTRL" 는 사용자가 넣은 키의 일부다). 전체 일치만 지우면 그 경우가 그대로 노출된다.
func redactAuthKey(text string, authKey string) string {
	if text == "" {
		return text
	}

	key := strings.TrimSpace(authKey)
	if len(key) >= minSecretRun {
		text = strings.ReplaceAll(text, key, maskSecret(key))
		text = maskTokens(text, func(token string) bool {
			return len(token) >= minSecretRun && strings.Contains(key, token)
		})
	}

	// 설정을 모르는 경로의 안전망. tskey- 로 시작하는 토큰은 그 자체로 키다.
	return maskTokens(text, func(token string) bool {
		return strings.HasPrefix(token, "tskey-")
	})
}

// maskTokens 는 공백으로 나눈 토큰 중 조건에 맞는 것을 가린다.
//
// 문장 부호는 토큰에서 떼어 두고 다시 붙인다 — "key k66…CNTRL." 처럼 끝에 붙어 오면 그것 때문에
// 일치가 깨진다.
func maskTokens(text string, secret func(token string) bool) string {
	fields := strings.Split(text, " ")
	for index, field := range fields {
		core := strings.Trim(field, ".,;:!?()[]\"'")
		if core == "" || !secret(core) {
			continue
		}
		fields[index] = strings.Replace(field, core, maskSecret(core), 1)
	}
	return strings.Join(fields, " ")
}

func maskSecret(secret string) string {
	if len(secret) <= secretKeepPrefix {
		return secretMask
	}
	return secret[:secretKeepPrefix] + secretMask
}
