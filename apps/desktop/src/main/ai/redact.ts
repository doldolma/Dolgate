// inspect_command 출력 등 원격 호스트에서 온 텍스트를 모델(egress)로 보내기 전 흔한 시크릿을 가린다.
// 정규식 기반이라 완벽하지 않다(방어적 심층방어). 렌더러 lib/ai-context-redact.ts 및 main
// provider-errors.ts 의 redact 패턴과 동일 계열 — 잘 알려진 키 형식 + 자격증명 대입/URL/PEM 위주.
export function redactSecrets(text: string): string {
  if (!text) {
    return text;
  }
  return (
    text
      // PEM 개인키 블록 전체 (여러 줄, 가장 먼저).
      .replace(
        /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
        "[REDACTED PRIVATE KEY]",
      )
      // URL 인라인 자격증명: scheme://user:pass@host → 비밀번호만 가림.
      .replace(/\b([a-z][a-z0-9+.\-]*:\/\/)([^\s:@/]+):[^\s@/]+@/gi, "$1$2:***@")
      // OpenAI / Anthropic 키.
      .replace(/\bsk-(?:ant-)?[A-Za-z0-9_\-]{6,}/g, "sk-***")
      // AWS access key id.
      .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "AWS_ACCESS_KEY_***")
      // GitHub 토큰.
      .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "ghp_***")
      // Google API 키.
      .replace(/\bAIza[A-Za-z0-9_\-]{20,}\b/g, "AIza***")
      // Slack 토큰.
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "xox***")
      // Authorization: Bearer <token>.
      .replace(/\bBearer\s+[A-Za-z0-9._\-]+/gi, "Bearer ***")
      // x-api-key 헤더.
      .replace(/\bx-api-key\b(["'\s:=]+)\S+/gi, "x-api-key$1***")
      // DB CLI 등 따옴표 붙은 -p'비밀번호'.
      .replace(/(\s-p)(['"])[^'"]+\2/g, "$1$2***$2")
      // key=value / key: value (시크릿류 키만) — 키·구분자는 두고 값만 가림.
      .replace(
        /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|auth[_-]?token|aws_secret_access_key)(["']?\s*[=:]\s*["']?)([^\s"']{3,})/gi,
        "$1$2***",
      )
  );
}
