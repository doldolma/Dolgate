const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const test = require("node:test");
const { mkdtemp, os, path, rm, writeDesktopState } = require("./helpers");

test("links the smoke AWS host to its managed profile by ID", async () => {
  const userDataDir = await mkdtemp(
    path.join(os.tmpdir(), "dolssh-smoke-state-"),
  );

  try {
    await writeDesktopState(userDataDir);
    const raw = await readFile(
      path.join(userDataDir, "storage", "state.json"),
      "utf8",
    );
    const state = JSON.parse(raw);
    const host = state.data.hosts.find((entry) => entry.id === "aws-1");
    const profile = state.data.awsProfiles.find(
      (entry) => entry.id === host.awsProfileId,
    );

    assert.ok(host.awsProfileId);
    assert.equal(profile?.name, "default");
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
