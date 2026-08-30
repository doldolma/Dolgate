import {
  normalizeCommandModule,
  type CommandSpec,
  type FigSpecNode,
} from '@dolssh/shared-core';
import {
  hasCommandModule,
  requireCommandModule,
} from '../generated/command-spec-modules';
import {
  getCommandSpecJson,
  getCommandSpecNamesJson,
} from '../engine/goEngine';

/**
 * 자동완성 명령 스펙을 엔진에서 하나씩 받아 온다.
 *
 * 데스크톱은 같은 스펙을 자기 번들에서 지연 로딩한다(Vite 의 `import.meta.glob`). Metro 에는
 * 그런 길이 없어 `require` 한 JSON 이 번들에 그대로 인라인되는데, 카탈로그 전체가 압축 전
 * 20 MB 다 — 시작 비용으로 낼 수 있는 값이 아니다. 그래서 이미 두 플랫폼에 링크돼 있는 Go
 * 엔진이 압축한 채(1.8 MB) 들고 있다가 명령을 칠 때 하나씩 풀어 준다.
 *
 * 그 대신 조회가 비동기라, 화면은 "아직 없음"을 지날 수 있어야 한다 — 스펙이 도착하면 다시
 * 그린다(useCommandSpec).
 */

/**
 * 네이티브 호출을 감싼다.
 *
 * JS 는 새것인데 깔려 있는 네이티브가 옛 빌드면 이 메서드가 아예 없어서 **동기 예외**가 난다
 * (`requireNative().getCommandSpec is not a function`). 그러면 아래 `.catch` 는 붙지도 못하고
 * 훅이 통째로 터진다 — 스펙은 자동완성의 보너스일 뿐이라 없으면 없는 대로 가야 한다.
 */
function callNative(query: () => Promise<string>): Promise<string> {
  try {
    return query();
  } catch {
    return Promise.resolve('');
  }
}

const specs = new Map<string, CommandSpec | null>();
const inflight = new Map<string, Promise<CommandSpec | null>>();

let names: Set<string> | null = null;
let namesInflight: Promise<Set<string>> | null = null;

/**
 * 스펙이 있는 이름 목록. 없는 이름을 칠 때마다 다리를 건너지 않기 위해 한 번만 받는다 —
 * 사용자가 치는 대부분은 스펙이 없는 이름이다(자기 스크립트·별칭).
 */
async function loadNames(): Promise<Set<string>> {
  if (names) return names;
  if (!namesInflight) {
    namesInflight = callNative(getCommandSpecNamesJson)
      .then(raw => {
        const parsed: unknown = JSON.parse(raw);
        const list = Array.isArray(parsed)
          ? parsed.filter((entry): entry is string => typeof entry === 'string')
          : [];
        names = new Set(list);
        return names;
      })
      .catch(() => {
        // 엔진이 답하지 못하면 이번 실행에서는 스펙 없이 간다. 히스토리·경로 추천은 그대로다.
        names = new Set<string>();
        return names;
      })
      .finally(() => {
        namesInflight = null;
      });
  }
  return namesInflight;
}

/** 이 이름에 스펙이 있는가. 목록을 아직 못 받았으면 없다고 본다(도착하면 다시 묻는다). */
export function hasCommandSpec(name: string): boolean {
  return names?.has(name) ?? false;
}

/** 이미 받아 둔 스펙. 없으면 null — 그 사이에도 화면은 그려져야 한다. */
export function getCachedCommandSpec(name: string): CommandSpec | null {
  return specs.get(name) ?? null;
}

/** 목록을 미리 받아 둔다. 세션이 준비될 때 한 번 부르면 첫 타이핑이 기다리지 않는다. */
export async function primeCommandSpecs(): Promise<void> {
  await loadNames();
}

export async function loadCommandSpec(name: string): Promise<CommandSpec | null> {
  const cached = specs.get(name);
  if (cached !== undefined) return cached;
  const pending = inflight.get(name);
  if (pending) return pending;

  const query = callNative(() => getCommandSpecJson(name))
    .then(raw => {
      const spec = raw ? (JSON.parse(raw) as CommandSpec) : null;
      specs.set(name, spec);
      return spec;
    })
    .catch(() => {
      // 한 번 실패한 이름은 담지 않는다 — 다음에 다시 시도할 수 있어야 한다.
      return null;
    })
    .finally(() => {
      inflight.delete(name);
    });
  inflight.set(name, query);
  return query;
}

/**
 * 제너레이터 모듈. 데스크톱과 **같은 정규화**를 거친다(기본 내보내기 벗기기 + 오버라이드).
 *
 * **적재 실패를 기억한다.** 지금 카탈로그(713개)는 RN 근사 환경에서 전부 적재된다 — RN 에 없는
 * 것(`document`·`Buffer`)을 쓰는 모듈은 있지만 전부 함수 안이라 require 시점에는 안 걸린다.
 * 다만 카탈로그는 Fig 상류를 그대로 따라오므로 언제든 최상위에서 그런 것을 건드리는 모듈이
 * 들어올 수 있다. 그때 여기서 막지 않으면 그 명령을 칠 때마다 키 하나에 한 번씩 같은 예외가
 * 난다. 제너레이터를 **돌리다** 나는 실패는 fig-runtime 이 이미 잡는다.
 */
const modules = new Map<string, FigSpecNode | null>();

export function hasCommandGeneratorModule(name: string): boolean {
  return hasCommandModule(name) && modules.get(name) !== null;
}

export function loadCommandGeneratorModule(name: string): FigSpecNode | null {
  const cached = modules.get(name);
  if (cached !== undefined) {
    return cached;
  }
  let spec: FigSpecNode | null = null;
  try {
    spec = normalizeCommandModule(name, requireCommandModule(name));
  } catch {
    spec = null;
  }
  modules.set(name, spec);
  return spec;
}
