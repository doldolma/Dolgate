import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mainDir = path.dirname(fileURLToPath(import.meta.url));

// 저장소 클래스는 레코드를 쓸 때(updateState 안) 볼트 뿌리의 edit 를 거친다 — 읽기 전용 팀이면 거기서 막힌다
// (vault-root.ts). data 로 바로 쓰면 그 관문을 건너뛰어, 서버가 거절할 편집이 로컬에 남는다.
// 동기화 장부는 이 기기만 쓰는 것이라 읽기 전용이어도 쓴다.
const DATA_WRITE_ALLOWED = new Set(["SyncOutboxRepository"]);

/** updateState 콜백마다 (그 콜백을 품은 클래스, 콜백 본문). */
function updateStateBlocks(source: string): Array<{ owner: string | null; body: string }> {
  const classes = [...source.matchAll(/^(?:export )?class (\w+)/gm)].map((match) => ({
    start: match.index ?? 0,
    name: match[1],
  }));
  const blocks: Array<{ owner: string | null; body: string }> = [];
  for (const match of source.matchAll(/stateStorage\.updateState\(\((\w+)\) => \{/g)) {
    const start = (match.index ?? 0) + match[0].length;
    let depth = 1;
    let end = start;
    while (depth > 0 && end < source.length) {
      if (source[end] === "{") depth += 1;
      if (source[end] === "}") depth -= 1;
      end += 1;
    }
    const owner = classes.filter((entry) => entry.start <= (match.index ?? 0)).at(-1)?.name ?? null;
    blocks.push({ owner, body: source.slice(start, end) });
  }
  return blocks;
}

describe("vault root write gate", () => {
  it("routes every repository write through the vault root's edit", () => {
    const source = fs.readFileSync(path.join(mainDir, "database.ts"), "utf8");
    const blocks = updateStateBlocks(source);
    expect(blocks.length).toBeGreaterThan(40);
    const offenders = blocks
      .filter((block) => !DATA_WRITE_ALLOWED.has(block.owner ?? "") && /\.root\.data\(/.test(block.body))
      .map((block) => `${block.owner}: ${block.body.trim().split("\n")[0]}`);
    expect(offenders).toEqual([]);
    // 관문을 실제로 쓰는 곳이 남아 있는지도 본다(이름이 바뀌어 위 검사가 헛돌지 않게).
    expect(blocks.filter((block) => /\.root\.edit\(/.test(block.body)).length).toBeGreaterThan(40);
  });
});
