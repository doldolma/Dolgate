package http

import (
	"bytes"
	"strings"
	"testing"
)

// The OIDC interstitial embeds the attacker-influenced code/state into HTML and
// must (1) only POST to /auth/oidc/complete (so a passive GET never exchanges the
// single-use code), (2) escape code/state to avoid XSS, and (3) auto-submit while
// deferring under prerender so prefetch/prerender cannot burn the code early.
func TestOIDCExchangeBridgeTemplateEscapesAndPosts(t *testing.T) {
	var buf bytes.Buffer
	if err := oidcExchangeBridgeTemplate.Execute(&buf, struct {
		Code  string
		State string
	}{Code: `abc"><script>alert(1)</script>`, State: "st&ate<x>"}); err != nil {
		t.Fatalf("template execute: %v", err)
	}
	out := buf.String()

	if !strings.Contains(out, `action="/auth/oidc/complete"`) || !strings.Contains(out, `method="POST"`) {
		t.Fatalf("interstitial must POST to /auth/oidc/complete so the GET never exchanges the code:\n%s", out)
	}
	if strings.Contains(out, "<script>alert(1)</script>") {
		t.Fatalf("interstitial must escape attacker-controlled code/state (XSS):\n%s", out)
	}
	if !strings.Contains(out, "form.submit") || !strings.Contains(out, "prerendering") {
		t.Fatalf("interstitial must auto-submit and guard against prerender:\n%s", out)
	}
}
