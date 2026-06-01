import { describe, expect, it } from "vitest";
import { isTransientAwsSsmSshError } from "./aws-ssm-ssh-retry";

describe("AWS SSM SSH retry policy", () => {
  it("treats tunnel startup handshake errors as transient", () => {
    expect(
      isTransientAwsSsmSshError(new Error("ssh handshake failed: EOF")),
    ).toBe(true);
    expect(isTransientAwsSsmSshError(new Error("connection refused"))).toBe(
      true,
    );
  });

  it("does not retry authentication or algorithm negotiation failures", () => {
    expect(
      isTransientAwsSsmSshError(
        new Error(
          "ssh handshake failed: ssh: unable to authenticate, attempted methods [none publickey], no supported methods remain",
        ),
      ),
    ).toBe(false);
    expect(
      isTransientAwsSsmSshError(
        new Error("ssh handshake failed: no matching host key type found"),
      ),
    ).toBe(false);
  });
});
