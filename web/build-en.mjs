// web/index.html(한국어)에서 web/en/index.html(영어)을 만든다.
//
// 한국어 원문은 마크업 자체이고 영어는 web/i18n.en.json 하나에만 있다 — 같은 문구를 두 파일에
// 나눠 들고 있으면 한쪽만 고치는 일이 반드시 생긴다. 생성물은 커밋하지 않고 배포 때 만든다
// (.github/workflows/pages.yml).
//
// 실행: node web/build-en.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webDir = dirname(fileURLToPath(import.meta.url));
const source = join(webDir, "index.html");
const dictPath = join(webDir, "i18n.en.json");
const outPath = join(webDir, "en", "index.html");

const html = await readFile(source, "utf8");
const dict = JSON.parse(await readFile(dictPath, "utf8"));

const problems = [];

// data-i18n / data-i18n-alt 로 표시된 곳과 사전이 정확히 맞는지 먼저 본다. 어긋난 채로
// 생성하면 영어 페이지에 한국어가 섞여 나가므로, 조용히 넘기지 않고 빌드를 세운다.
const markupKeys = new Set(
  [...html.matchAll(/data-i18n(?:-alt|-title)?="([^"]+)"/g)].map((m) => m[1]),
);
const dictKeys = new Set(Object.keys(dict.keys));
for (const key of markupKeys) {
  if (!dictKeys.has(key)) problems.push(`사전에 없는 키: ${key}`);
}
for (const key of dictKeys) {
  if (!markupKeys.has(key)) problems.push(`마크업에서 쓰이지 않는 키: ${key}`);
}

let out = html;
const replaceOnce = (pattern, replacement, label) => {
  const before = out;
  out = out.replace(pattern, replacement);
  if (out === before) problems.push(`치환 실패: ${label}`);
};

// 1) 본문 — data-i18n 은 내용, data-i18n-alt 는 alt 속성.
out = out.replace(
  /(<([a-z0-9]+)\b[^>]*\bdata-i18n="([^"]+)"[^>]*>)([\s\S]*?)(<\/\2>)/g,
  (whole, open, _tag, key, _inner, close) => {
    const value = dict.keys[key];
    return value === undefined ? whole : `${open}${value}${close}`;
  },
);
// title 과 aria-label 은 JS 가 뒤에 덮어쓰지만, 실행 전·JS 비활성 상태에서는 이 값이 보인다.
out = out.replace(
  /(<[^>]*\bdata-i18n-title="([^"]+)"[^>]*)/g,
  (whole, tag, key) => {
    const value = dict.keys[key];
    if (value === undefined) return whole;
    // (?<!-) 가 없으면 data-i18n-title 자신의 값이 먼저 걸린다("...-title=" 이 title= 로 끝난다).
    return tag
      .replace(/(?<!-)title="[^"]*"/, `title="${value}"`)
      .replace(/aria-label="[^"]*"/, `aria-label="${value}"`);
  },
);
out = out.replace(
  /(<[^>]*\bdata-i18n-alt="([^"]+)"[^>]*?\balt=")[^"]*(")/g,
  (whole, head, key, tail) => {
    const value = dict.keys[key];
    return value === undefined ? whole : `${head}${value}${tail}`;
  },
);

// 2) <head> — lang, title, meta. 소셜 스크레이퍼는 JS 를 실행하지 않으므로 이 값들이
//    원본 HTML 에 영어로 들어 있어야 영어 링크 미리보기가 영어로 나온다.
replaceOnce(/<html lang="ko">/, '<html lang="en">', "html lang");
replaceOnce(/(<title>)[\s\S]*?(<\/title>)/, `$1${dict.meta.title}$2`, "title");
replaceOnce(
  /(<meta name="description" content=")[^"]*(")/,
  `$1${dict.meta.description}$2`,
  "meta description",
);
replaceOnce(
  /(<meta property="og:title" content=")[^"]*(")/,
  `$1${dict.meta.ogTitle}$2`,
  "og:title",
);
replaceOnce(
  /(<meta property="og:description" content=")[^"]*(")/,
  `$1${dict.meta.ogDescription}$2`,
  "og:description",
);

// 3) canonical 은 자기 자신을, hreflang 쌍은 양쪽 페이지에서 동일하게 유지한다.
replaceOnce(
  /(<link rel="canonical" href="https:\/\/doldolma\.github\.io\/Dolgate\/)(" \/>)/,
  "$1en/$2",
  "canonical",
);

// 4) 언어 링크는 반대쪽을 가리킨다.
replaceOnce(
  /<a class="btn icon-btn" id="lang-link"[^>]*>[^<]*<\/a>/,
  '<a class="btn icon-btn" id="lang-link" href="../" hreflang="ko" title="한국어" aria-label="한국어">한</a>',
  "언어 링크",
);

// 5) JS 가 만드는 문구.
replaceOnce(
  /window\.dolgateStrings = \{[\s\S]*?\};/,
  `window.dolgateStrings = ${JSON.stringify(dict.runtime, null, 4).replace(/\n/g, "\n  ")};`,
  "dolgateStrings",
);

// 6) 한 단계 아래 디렉터리로 나가므로 상대 경로를 올린다.
out = out.replaceAll('="./assets/', '="../assets/');

if (problems.length) {
  console.error("web/en 생성 실패:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

// 생성물임을 파일 안에도 남긴다 — 이 파일을 직접 고치면 다음 배포에서 덮어써진다.
out = out.replace(
  /^<!doctype html>/i,
  "<!doctype html>\n<!-- 생성된 파일 — web/index.html + web/i18n.en.json 에서 web/build-en.mjs 가 만든다. 직접 고치지 말 것. -->",
);

await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, out);
console.log(
  `web/en/index.html 생성 — 번역 ${Object.keys(dict.keys).length}곳, 런타임 문구 ${Object.keys(dict.runtime).length}개`,
);
