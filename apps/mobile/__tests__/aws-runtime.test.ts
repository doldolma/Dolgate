import {
  assertAwsRuntimeReady,
  ensureAwsRuntimeGlobals,
  getMissingAwsRuntimeGlobals,
} from "../src/lib/aws-runtime";

describe("aws-runtime", () => {
  it("installs only the missing AWS runtime globals", () => {
    const existingReadableStream = function ExistingReadableStream() {};
    const target: {
      ReadableStream?: unknown;
      WritableStream?: unknown;
      TransformStream?: unknown;
      structuredClone?: unknown;
      URL?: unknown;
      URLSearchParams?: unknown;
    } = {
      ReadableStream: existingReadableStream,
    };

    expect(getMissingAwsRuntimeGlobals(target)).toEqual([
      "WritableStream",
      "TransformStream",
      "structuredClone",
      "URL",
      "URLSearchParams",
    ]);

    const missingAfterInstall = ensureAwsRuntimeGlobals(target);

    expect(missingAfterInstall).toEqual([]);
    expect(target.ReadableStream).toBe(existingReadableStream);
    expect(typeof target.WritableStream).toBe("function");
    expect(typeof target.TransformStream).toBe("function");
    expect(typeof target.structuredClone).toBe("function");
    expect(typeof target.URL).toBe("function");
    expect(typeof target.URLSearchParams).toBe("function");
  });

  it("throws a clear error when required globals are still unavailable", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      expect(() => assertAwsRuntimeReady({})).toThrow(
        "모바일 AWS 런타임 초기화가 완료되지 않았습니다.",
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
