import type { RdpCertificatePrompt as RdpCertificatePromptData } from "@shared";
import { Button } from "../../ui";

interface RdpCertificatePromptProps {
  prompt: RdpCertificatePromptData;
  onDecide: (accept: boolean) => void;
}

// 서버 인증서를 신뢰할지 묻는다.
//
// 이 화면이 떠 있는 동안 접속은 CredSSP 직전에 멈춰 있다 — 거절하면 비밀번호는 전송되지 않는다.
export function RdpCertificatePrompt({ prompt, onDecide }: RdpCertificatePromptProps) {
  const changed = prompt.status === "changed";

  return (
    <div className="flex h-full w-full items-center justify-center bg-[var(--surface-1,#0b1220)] p-6">
      <div className="w-full max-w-[34rem] rounded-[0.9rem] border border-[var(--border-soft,#243049)] bg-[var(--surface-2,#111a2b)] p-6">
        <h3 className="text-[1.02rem] font-semibold text-[var(--text-strong,#e8eefc)]">
          {changed
            ? "서버 인증서가 이전과 다릅니다"
            : "이 서버를 처음 연결합니다"}
        </h3>

        <p className="mt-2 text-[0.86rem] leading-[1.5] text-[var(--text-soft,#9fb0cc)]">
          {changed ? (
            <>
              <span className="text-[var(--color-danger,#ef4444)]">{prompt.hostLabel}</span>
              의 인증서가 바뀌었습니다. 서버를 재설치했다면 정상이지만, 다른 기계에 연결되고
              있는 것일 수도 있습니다. 지문을 확인할 수 없다면 연결하지 마세요.
            </>
          ) : (
            <>
              RDP 서버는 대개 자체 서명 인증서를 쓰기 때문에 발급 기관으로는 신원을 확인할 수
              없습니다. 아래 지문을 기록해 두면 다음부터 서버가 바뀌었는지 알 수 있습니다.
            </>
          )}
        </p>

        <dl className="mt-4 grid gap-2 text-[0.8rem]">
          <Row label="지문 (SHA-256)" value={prompt.certificate.fingerprint} mono emphasis />
          {changed && prompt.previousFingerprint ? (
            <Row label="이전에 신뢰한 지문" value={prompt.previousFingerprint} mono />
          ) : null}
          <Row label="주체" value={prompt.certificate.subject} />
          <Row label="발급자" value={prompt.certificate.issuer} />
          <Row label="만료" value={prompt.certificate.notAfter} />
        </dl>

        <p className="mt-4 text-[0.78rem] leading-[1.45] text-[var(--text-soft,#9fb0cc)]">
          연결하지 않으면 비밀번호는 서버로 전송되지 않습니다.
        </p>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onDecide(false)}>
            연결하지 않음
          </Button>
          <Button onClick={() => onDecide(true)}>
            {changed ? "새 인증서를 신뢰" : "신뢰하고 연결"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  emphasis,
}: {
  label: string;
  value: string;
  mono?: boolean;
  emphasis?: boolean;
}) {
  return (
    <div className="grid grid-cols-[9rem_1fr] items-start gap-3">
      <dt className="text-[var(--text-soft,#9fb0cc)]">{label}</dt>
      <dd
        className={[
          "break-all",
          mono ? "font-mono text-[0.76rem]" : "",
          emphasis
            ? "text-[var(--text-strong,#e8eefc)]"
            : "text-[var(--text-default,#c7d3ea)]",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {value}
      </dd>
    </div>
  );
}
