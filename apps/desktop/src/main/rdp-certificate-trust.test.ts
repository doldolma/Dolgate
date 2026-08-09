import { describe, expect, it, vi } from "vitest";
import type { RdpCertificateInfo } from "@shared";
import { decideCertificate, type CertificateDecisionDeps } from "./rdp-certificate-trust";

const CERT: RdpCertificateInfo = {
  fingerprint: "AA:BB:CC",
  subject: "CN=win-box",
  issuer: "CN=win-box",
  notAfter: "2027-01-01T00:00:00Z",
};

function createDeps(overrides: Partial<CertificateDecisionDeps> = {}) {
  return {
    lookupHost: vi.fn(() => ({
      hostId: "rdp-1",
      label: "Win Box",
      fingerprint: null as string | null,
    })),
    ask: vi.fn(async () => true),
    persist: vi.fn(),
    ...overrides,
  } satisfies CertificateDecisionDeps & Record<string, unknown>;
}

describe("decideCertificate", () => {
  it("accepts a matching pin without bothering the user", async () => {
    const deps = createDeps({
      lookupHost: () => ({ hostId: "rdp-1", label: "Win Box", fingerprint: "AA:BB:CC" }),
    });

    await expect(decideCertificate(deps, "s1", CERT)).resolves.toBe(true);

    // 매번 묻는 프롬프트는 사용자가 읽지 않고 누르게 만든다.
    expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.persist).not.toHaveBeenCalled();
  });

  it("asks on first sight and records the pin once trusted", async () => {
    const deps = createDeps();

    await expect(decideCertificate(deps, "s1", CERT)).resolves.toBe(true);

    expect(deps.ask).toHaveBeenCalledWith(
      expect.objectContaining({ status: "unknown", previousFingerprint: null }),
    );
    expect(deps.persist).toHaveBeenCalledWith("rdp-1", "AA:BB:CC");
  });

  it("flags a changed certificate and shows what was trusted before", async () => {
    const deps = createDeps({
      lookupHost: () => ({ hostId: "rdp-1", label: "Win Box", fingerprint: "OLD:PIN" }),
    });

    await decideCertificate(deps, "s1", CERT);

    expect(deps.ask).toHaveBeenCalledWith(
      expect.objectContaining({ status: "changed", previousFingerprint: "OLD:PIN" }),
    );
  });

  it("does not overwrite the stored pin when the user refuses", async () => {
    const deps = createDeps({
      lookupHost: () => ({ hostId: "rdp-1", label: "Win Box", fingerprint: "OLD:PIN" }),
      ask: vi.fn(async () => false),
    });

    await expect(decideCertificate(deps, "s1", CERT)).resolves.toBe(false);

    expect(deps.persist).not.toHaveBeenCalled();
  });

  it("refuses when the session no longer maps to a host", async () => {
    const deps = createDeps({ lookupHost: () => null });

    // 어느 호스트인지 모르면 신뢰 근거가 없다 — 통과시키면 핀이 무의미해진다.
    await expect(decideCertificate(deps, "s1", CERT)).resolves.toBe(false);
    expect(deps.ask).not.toHaveBeenCalled();
  });
});
