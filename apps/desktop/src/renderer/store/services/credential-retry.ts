import { isSshHostDraft } from "@shared";
import type { SliceDeps } from "./context";
import { isSshHostRecord, sortHosts, toHostDraft } from "../utils";

export async function updateStoredSshUsername(
  deps: Pick<SliceDeps, "api" | "get" | "set">,
  hostId: string,
  username: string,
) {
  const currentHost = deps.get().hosts.find((item) => item.id === hostId);
  if (!currentHost || !isSshHostRecord(currentHost)) {
    return null;
  }

  const trimmedUsername = username.trim();
  if (trimmedUsername === currentHost.username.trim()) {
    return currentHost;
  }

  const currentDraft = toHostDraft(currentHost, currentHost.label);
  if (!isSshHostDraft(currentDraft)) {
    return null;
  }

  const nextHost = await deps.api.hosts.update(currentHost.id, {
    ...currentDraft,
    username: trimmedUsername,
  });

  deps.set((state) => ({
    hosts: sortHosts([
      ...state.hosts.filter((host) => host.id !== nextHost.id),
      nextHost,
    ]),
  }));

  return nextHost;
}
