import React from "react";
import renderer, { act } from "react-test-renderer";

const autocompleteResult = {
  capability: {
    status: "ready" as const,
    shell: "bash" as const,
    sources: ["history", "executable", "session-history"] as const,
  },
  snapshot: {
    shell: "bash" as const,
    revision: 1,
    history: ["git status"],
    executables: [{ name: "git", path: "/usr/bin/git" }],
    truncated: false,
  },
};
const mockPrepareSessionAutocomplete = jest.fn(
  async (_sessionId: string) => autocompleteResult,
);

jest.mock("../src/store/useMobileAppStore", () => ({
  prepareSessionAutocomplete: (sessionId: string) =>
    mockPrepareSessionAutocomplete(sessionId),
  runSessionCompletion: jest.fn(async () => ({ stdout: "", truncated: false })),
}));

import { useTerminalAutocomplete } from "../src/hooks/useTerminalAutocomplete";

type HookResult = ReturnType<typeof useTerminalAutocomplete>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function Harness({
  connected,
  onResult,
}: {
  connected: boolean;
  onResult: (result: HookResult) => void;
}) {
  const result = useTerminalAutocomplete({
    sessionId: "session-1",
    enabled: true,
    connected,
    sendInput: jest.fn(),
  });
  onResult(result);
  return null;
}

describe("useTerminalAutocomplete", () => {
  beforeEach(() => {
    mockPrepareSessionAutocomplete.mockReset();
    mockPrepareSessionAutocomplete.mockResolvedValue(autocompleteResult);
  });

  it("keeps the first line buffer when a continuation prompt starts", async () => {
    let current: HookResult | null = null;
    await act(async () => {
      renderer.create(
        <Harness connected onResult={(result) => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration("B");
    });
    act(() => {
      current!.send("echo first");
      current!.handleShellIntegration("B;2");
    });
    expect(current!.command).toBe("echo first");
    expect(current!.suggestions).toEqual([]);
  });

  it("prepares again after reconnecting the same session record", async () => {
    let current: HookResult | null = null;
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <Harness connected onResult={(result) => (current = result)} />,
      );
    });
    await act(async () => {
      current!.handleShellIntegration("B");
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      tree!.update(
        <Harness connected={false} onResult={(result) => (current = result)} />,
      );
    });
    await act(async () => {
      tree!.update(
        <Harness connected onResult={(result) => (current = result)} />,
      );
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(1);

    await act(async () => {
      current!.handleShellIntegration("B");
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(2);
  });

  it("does not let an old prepare clear the new connection's in-flight work", async () => {
    const first = deferred<typeof autocompleteResult>();
    const second = deferred<typeof autocompleteResult>();
    mockPrepareSessionAutocomplete
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    let current: HookResult | null = null;
    let tree: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <Harness connected onResult={(result) => (current = result)} />,
      );
    });
    act(() => {
      current!.handleShellIntegration("B");
    });
    await act(async () => {
      tree!.update(
        <Harness connected={false} onResult={(result) => (current = result)} />,
      );
    });
    await act(async () => {
      tree!.update(
        <Harness connected onResult={(result) => (current = result)} />,
      );
    });
    act(() => {
      current!.handleShellIntegration("B");
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(2);

    await act(async () => {
      first.resolve(autocompleteResult);
      await first.promise;
    });
    act(() => {
      current!.handleShellIntegration("B");
    });
    expect(mockPrepareSessionAutocomplete).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve(autocompleteResult);
      await second.promise;
    });
  });
});
