import type { PortForwardRuntimeRecord } from "@shared";

export function arePortForwardRuntimeRecordsEqual(
  left: PortForwardRuntimeRecord | null,
  right: PortForwardRuntimeRecord | null,
): boolean {
  if (left === right) {
    return true;
  }
  if (!left || !right) {
    return false;
  }
  return (
    left.ruleId === right.ruleId &&
    left.hostId === right.hostId &&
    left.transport === right.transport &&
    left.bindAddress === right.bindAddress &&
    left.bindPort === right.bindPort &&
    left.status === right.status &&
    left.updatedAt === right.updatedAt &&
    left.startedAt === right.startedAt &&
    left.mode === right.mode &&
    left.method === right.method &&
    left.message === right.message
  );
}

export function upsertForwardRuntime(
  runtimes: PortForwardRuntimeRecord[],
  runtime: PortForwardRuntimeRecord,
): PortForwardRuntimeRecord[] {
  const next = [
    runtime,
    ...runtimes.filter((item) => item.ruleId !== runtime.ruleId),
  ];
  return next.sort((a, b) => a.ruleId.localeCompare(b.ruleId));
}
