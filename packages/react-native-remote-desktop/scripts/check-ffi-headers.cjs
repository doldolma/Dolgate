#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(packageRoot, '..', '..');

const headerGroups = [
  {
    name: 'VNC',
    symbolPrefix: 'DVNC_',
    canonical: path.join(repositoryRoot, 'services/vnc-core/include/dvnc.h'),
    rustSource: path.join(repositoryRoot, 'services/vnc-core/src/ffi.rs'),
    copies: [
      path.join(packageRoot, 'android/src/main/jni/dvnc_ffi.h'),
      path.join(packageRoot, 'ios/dvnc.h'),
    ],
  },
  {
    name: 'RDP',
    symbolPrefix: 'DRDP_',
    canonical: path.join(repositoryRoot, 'services/rdp-core/include/drdp.h'),
    rustSource: path.join(repositoryRoot, 'services/rdp-core/src/ffi.rs'),
    copies: [
      path.join(packageRoot, 'android/src/main/jni/drdp_ffi.h'),
      path.join(packageRoot, 'ios/drdp.h'),
    ],
  },
];

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

function normalizeDeclaration(source) {
  return source.replace(/\s+/g, '');
}

function sortedObject(entries) {
  return Object.fromEntries(
    [...entries].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function extractManifest(filePath, symbolPrefix) {
  const source = stripComments(fs.readFileSync(filePath, 'utf8'));

  const constants = new Map();
  const definePattern = /^#define[ \t]+(\w+)[ \t]+([^\n]+)$/gm;
  for (const match of source.matchAll(definePattern)) {
    if (match[1].startsWith(symbolPrefix)) {
      constants.set(match[1], match[2].replace(/[()\s]/g, ''));
    }
  }

  const handles = new Map();
  const handlePattern = /typedef\s+void\s*\*\s*(\w+Handle)\s*;/g;
  for (const match of source.matchAll(handlePattern)) {
    handles.set(match[1], 'void*');
  }

  const callbacks = new Map();
  const callbackPattern = /typedef\s+void\s*\(\s*\*\s*(\w+)\s*\)\s*\(([\s\S]*?)\)\s*;/g;
  for (const match of source.matchAll(callbackPattern)) {
    callbacks.set(match[1], normalizeDeclaration(match[2]));
  }

  const structs = new Map();
  const structPattern = /typedef\s+struct(?:\s+\w+)?\s*\{([\s\S]*?)\}\s*(\w+)\s*;/g;
  for (const match of source.matchAll(structPattern)) {
    const fields = match[1]
      .split(';')
      .map(normalizeDeclaration)
      .filter(Boolean);
    structs.set(match[2], fields);
  }

  const functions = new Map();
  const functionPattern = /int32_t\s+(\w+)\s*\(([\s\S]*?)\)\s*;/g;
  for (const match of source.matchAll(functionPattern)) {
    functions.set(match[1], normalizeDeclaration(match[2]));
  }

  return {
    constants: sortedObject(constants),
    handles: sortedObject(handles),
    callbacks: sortedObject(callbacks),
    structs: sortedObject(structs),
    functions: sortedObject(functions),
  };
}

/**
 * Rust 쪽 진실. 헤더 사본끼리만 비교하면 **네 파일이 나란히 틀려 있어도 통과한다** — 그때 앱은
 * 런타임에 ABI 불일치로 죽는다(호출 규약이 어긋난 채 메모리를 쓴다). 그래서 정본 헤더가 실제
 * `#[no_mangle]` 함수 이름과 `pub const` 값과 맞는지도 본다.
 *
 * 파서를 얕게 유지한다: 이름과 상수 값까지만 대조하고 인자 타입은 보지 않는다. 타입 매핑을
 * 흉내내기 시작하면 그 매핑이 또 하나의 어긋날 수 있는 사본이 된다. 실제로 겪는 사고는
 * "함수를 추가/이름 변경하고 헤더를 잊는 것" 과 "에러 코드 값을 바꾸는 것" 이고, 둘 다 여기서 잡힌다.
 */
function extractRustManifest(filePath, symbolPrefix) {
  const source = fs.readFileSync(filePath, 'utf8');

  const constants = new Map();
  const constPattern = new RegExp(
    `pub const (${symbolPrefix}\\w+)\\s*:\\s*i32\\s*=\\s*(-?\\d+)\\s*;`,
    'g',
  );
  for (const match of source.matchAll(constPattern)) {
    constants.set(match[1], match[2]);
  }

  const functions = new Set();
  const functionPattern =
    /#\[no_mangle\][\s\S]{0,200}?extern "C" fn\s+(\w+)\s*\(/g;
  for (const match of source.matchAll(functionPattern)) {
    functions.add(match[1]);
  }

  return { constants: sortedObject(constants), functions: [...functions].sort() };
}

function relativePath(filePath) {
  return path.relative(repositoryRoot, filePath);
}

let failed = false;
for (const group of headerGroups) {
  const expected = extractManifest(group.canonical, group.symbolPrefix);

  // 1) 정본 헤더 ↔ Rust 구현.
  const rust = extractRustManifest(group.rustSource, group.symbolPrefix);
  const headerFunctions = Object.keys(expected.functions).sort();
  const missingInHeader = rust.functions.filter(
    (name) => !headerFunctions.includes(name),
  );
  const missingInRust = headerFunctions.filter(
    (name) => !rust.functions.includes(name),
  );
  const mismatchedConstants = Object.keys(rust.constants).filter(
    (name) =>
      name in expected.constants &&
      expected.constants[name] !== rust.constants[name],
  );
  const constantsMissingInHeader = Object.keys(rust.constants).filter(
    (name) => !(name in expected.constants),
  );

  if (
    missingInHeader.length > 0 ||
    missingInRust.length > 0 ||
    mismatchedConstants.length > 0 ||
    constantsMissingInHeader.length > 0
  ) {
    failed = true;
    console.error(
      `ABI drift: ${relativePath(group.canonical)} does not match ${relativePath(group.rustSource)}`,
    );
    if (missingInHeader.length > 0) {
      console.error(`  exported by Rust but absent from the header: ${missingInHeader.join(', ')}`);
    }
    if (missingInRust.length > 0) {
      console.error(`  declared in the header but not exported by Rust: ${missingInRust.join(', ')}`);
    }
    if (constantsMissingInHeader.length > 0) {
      console.error(`  constants missing from the header: ${constantsMissingInHeader.join(', ')}`);
    }
    for (const name of mismatchedConstants) {
      console.error(
        `  ${name}: header ${expected.constants[name]} vs Rust ${rust.constants[name]}`,
      );
    }
  } else {
    console.log(
      `OK ${group.name}: ${relativePath(group.canonical)} matches ${relativePath(group.rustSource)} ` +
        `(${rust.functions.length} exports, ${Object.keys(rust.constants).length} constants)`,
    );
  }

  // 2) 정본 헤더 ↔ 모바일 사본.

  for (const copy of group.copies) {
    const actual = extractManifest(copy, group.symbolPrefix);
    const differingSections = Object.keys(expected).filter(
      (section) =>
        JSON.stringify(actual[section]) !== JSON.stringify(expected[section]),
    );
    if (differingSections.length === 0) {
      console.log(
        `OK ${group.name}: ${relativePath(copy)} matches ${relativePath(group.canonical)}`,
      );
      continue;
    }

    failed = true;
    console.error(
      `ABI drift: ${relativePath(copy)} does not match ${relativePath(group.canonical)}`,
    );
    for (const section of differingSections) {
      console.error(`  ${section}:`);
      console.error(`    expected ${JSON.stringify(expected[section])}`);
      console.error(`    actual   ${JSON.stringify(actual[section])}`);
    }
  }
}

if (failed) {
  console.error('Update every mobile header copy to match its canonical service header.');
  process.exitCode = 1;
}
