import { existsSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TeamReplayCache } from "./team-replay-cache";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openCache(limitBytes?: number) {
  const stateDir = mkdtempSync(path.join(os.tmpdir(), "team-replay-cache-"));
  directories.push(stateDir);
  const cache = new TeamReplayCache(limitBytes);
  cache.activate(stateDir);
  return { cache, root: path.join(stateDir, "replay-cache") };
}

/** 파일 시각을 옛날로 돌려 "오래 안 쓴 것"을 만든다. */
function age(root: string, relative: string, secondsAgo: number) {
  const when = new Date(Date.now() - secondsAgo * 1000);
  utimesSync(path.join(root, relative), when, when);
}

describe("TeamReplayCache", () => {
  it("keeps pieces as they were given", () => {
    const { cache } = openCache();
    cache.write("team-a", "rec-1", "segment-0", Uint8Array.of(1, 2, 3));
    expect([...(cache.read("team-a", "rec-1", "segment-0") ?? [])]).toEqual([1, 2, 3]);
    expect(cache.read("team-a", "rec-1", "segment-1")).toBeNull();
  });

  it("drops what was used least recently once it grows past the limit", () => {
    const { cache, root } = openCache(1000);
    cache.write("team-a", "rec-1", "segment-0", new Uint8Array(400));
    cache.write("team-a", "rec-1", "segment-1", new Uint8Array(400));
    age(root, "team-a/rec-1/segment-0", 60);
    age(root, "team-a/rec-1/segment-1", 30);
    // segment-0 을 다시 읽어 최근에 쓴 것으로 만든다.
    cache.read("team-a", "rec-1", "segment-0");
    cache.write("team-b", "rec-2", "segment-0", new Uint8Array(400));
    expect(cache.read("team-a", "rec-1", "segment-1")).toBeNull();
    expect(cache.read("team-a", "rec-1", "segment-0")).not.toBeNull();
    expect(cache.read("team-b", "rec-2", "segment-0")).not.toBeNull();
  });

  it("forgets one team, then everything", () => {
    const { cache, root } = openCache();
    cache.write("team-a", "rec-1", "segment-0", Uint8Array.of(1));
    cache.write("team-b", "rec-2", "segment-0", Uint8Array.of(2));
    cache.forgetTeam("team-a");
    expect(existsSync(path.join(root, "team-a"))).toBe(false);
    expect(existsSync(path.join(root, "team-b"))).toBe(true);
    cache.purgeAll();
    expect(existsSync(root)).toBe(false);
  });

  it("never turns an ID into a path outside the cache", () => {
    const { cache, root } = openCache();
    cache.write("..", "rec-1", "segment-0", Uint8Array.of(1));
    cache.write("team-a", "../../escape", "segment-0", Uint8Array.of(1));
    cache.write("team-a", "a/b", "segment-0", Uint8Array.of(1));
    expect(existsSync(root)).toBe(false);
    cache.forgetTeam("..");
    expect(existsSync(path.dirname(root))).toBe(true);
  });
});
