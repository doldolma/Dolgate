import { describe, expect, it } from "vitest";
import { normalizeAiError } from "./provider-errors";

describe("normalizeAiError (vision 400 mapping)", () => {
  it("maps a 400 mentioning image/vision to the vision-unsupported message", () => {
    const error = Object.assign(new Error("This model does not support image input"), {
      status: 400,
    });
    const result = normalizeAiError(error);
    expect(result.reason).toBe("invalid-response");
    expect(result.message).toContain("이미지 입력을 지원하지 않는");
  });

  it("maps image_url keyword on a 422 the same way", () => {
    const error = Object.assign(new Error("invalid content part type: image_url"), {
      status: 422,
    });
    const result = normalizeAiError(error);
    expect(result.message).toContain("이미지 입력을 지원하지 않는");
  });

  it("keeps the generic message for a 400 without image keywords", () => {
    const error = Object.assign(new Error("max_tokens too large"), { status: 400 });
    const result = normalizeAiError(error);
    expect(result.reason).toBe("invalid-response");
    expect(result.message).toBe("요청이 거부되었습니다. 모델·설정을 확인하세요.");
  });
});
