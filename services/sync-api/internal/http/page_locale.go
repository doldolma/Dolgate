package http

import (
	"sort"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

// 브라우저에 보이는 인증 페이지의 UI 언어를 정한다. 앱은 실행 중 한 번 정하면 되지만
// 서버는 요청마다 새로 판정해야 한다 — 같은 서버를 쓰는 사용자들의 언어가 서로 다르다.
//
// 지원 언어는 앱(shared-core 의 APP_LOCALES)과 같게 유지한다. 한쪽만 늘리면 앱에서 고른
// 언어가 로그인 페이지에서 조용히 무시된다.

type pageLocale string

const (
	pageLocaleKo pageLocale = "ko"
	pageLocaleEn pageLocale = "en"
)

// 앱의 DEFAULT_APP_LOCALE 과 같다. Accept-Language 도 lang 도 없는 클라이언트(대부분
// 자동화 도구)에만 적용된다.
const defaultPageLocale = pageLocaleEn

// langQueryParam 은 앱이 자기 UI 언어를 실어 보내는 쿼리·폼 파라미터다. 없으면 브라우저
// 설정(Accept-Language)을 따른다 — 앱을 거치지 않고 브라우저로 직접 들어온 경우다.
const langQueryParam = "lang"

// normalizePageLocale 은 'ko-KR', 'ko_KR', 'KO' 같은 값을 지원 언어로 정규화한다.
// 지역 코드는 무시하고 언어만 본다(앱의 resolveAppLocale 과 같은 규칙).
func normalizePageLocale(value string) (pageLocale, bool) {
	trimmed := strings.TrimSpace(strings.ToLower(value))
	if trimmed == "" {
		return "", false
	}
	language := trimmed
	if index := strings.IndexAny(language, "-_"); index >= 0 {
		language = language[:index]
	}
	switch language {
	case "ko":
		return pageLocaleKo, true
	case "en":
		return pageLocaleEn, true
	default:
		return "", false
	}
}

// resolvePageLocale 은 lang 파라미터 → Accept-Language → 기본값 순으로 언어를 정한다.
// 폼 POST 도 같은 이름의 필드를 실어 보내므로 GET/POST 모두 한 함수로 처리된다.
func resolvePageLocale(ctx *gin.Context) pageLocale {
	if locale, ok := normalizePageLocale(explicitLangParam(ctx)); ok {
		return locale
	}
	if locale, ok := parseAcceptLanguage(ctx.GetHeader("Accept-Language")); ok {
		return locale
	}
	return defaultPageLocale
}

func explicitLangParam(ctx *gin.Context) string {
	if value := strings.TrimSpace(ctx.Query(langQueryParam)); value != "" {
		return value
	}
	// PostForm 은 폼 본문을 읽는다 — GET 요청에서는 빈 문자열이라 부작용이 없다.
	return strings.TrimSpace(ctx.PostForm(langQueryParam))
}

// parseAcceptLanguage 는 'ko-KR,ko;q=0.9,en;q=0.8' 같은 헤더에서 q 값이 가장 높은 지원
// 언어를 고른다. q 가 없으면 1.0, q=0 은 "원하지 않음" 이라 건너뛴다.
func parseAcceptLanguage(header string) (pageLocale, bool) {
	if strings.TrimSpace(header) == "" {
		return "", false
	}
	type candidate struct {
		locale pageLocale
		weight float64
		order  int
	}
	candidates := make([]candidate, 0, 4)
	for index, entry := range strings.Split(header, ",") {
		parts := strings.Split(entry, ";")
		locale, ok := normalizePageLocale(parts[0])
		if !ok {
			continue
		}
		weight := 1.0
		for _, parameter := range parts[1:] {
			trimmed := strings.TrimSpace(parameter)
			if !strings.HasPrefix(trimmed, "q=") {
				continue
			}
			parsed, err := strconv.ParseFloat(strings.TrimPrefix(trimmed, "q="), 64)
			if err != nil {
				continue
			}
			weight = parsed
		}
		if weight <= 0 {
			continue
		}
		candidates = append(candidates, candidate{locale: locale, weight: weight, order: index})
	}
	if len(candidates) == 0 {
		return "", false
	}
	// q 가 같으면 헤더에 먼저 나온 언어를 쓴다(RFC 7231 의 관행).
	sort.SliceStable(candidates, func(i, j int) bool {
		if candidates[i].weight != candidates[j].weight {
			return candidates[i].weight > candidates[j].weight
		}
		return candidates[i].order < candidates[j].order
	})
	return candidates[0].locale, true
}
