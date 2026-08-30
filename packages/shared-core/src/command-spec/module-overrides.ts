import type { FigGenerator, FigSpecNode, FigSuggestion } from './fig-runtime';

interface FigArgNode {
  generators?: FigGenerator | FigGenerator[];
}

interface FigOptionNode {
  args?: FigArgNode | FigArgNode[];
}

const DOCKER_JSON_PS_SCRIPT = ['docker', 'ps', '--format', '{{ json . }}'];
const DOCKER_FAST_PS_SCRIPT = ['docker', 'ps', '--format', '{{.Names}}\t{{.Image}}'];

export function applyCommandModuleOverrides(
  name: string,
  spec: FigSpecNode,
): FigSpecNode {
  if (name !== 'docker') {
    return spec;
  }
  return overrideDockerContainerGenerators(spec);
}

export function parseDockerContainerRows(output: string): FigSuggestion[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      const [name, image = ''] = line.split('\t');
      if (!name) {
        return [];
      }
      return [{
        name,
        displayName: image ? `${name} (${image})` : name,
        icon: 'fig://icon?type=docker',
      }];
    });
}

function overrideDockerContainerGenerators(spec: FigSpecNode): FigSpecNode {
  const copy = cloneSpecNode(spec);
  walkSpec(copy, (node) => {
    replaceArgGenerators(node.args);
    for (const option of node.options ?? []) {
      replaceArgGenerators(option.args);
    }
  });
  return copy;
}

function replaceArgGenerators(args: FigArgNode | FigArgNode[] | undefined) {
  for (const arg of asArray(args)) {
    const replaced = replaceGenerator(arg.generators);
    if (replaced) {
      arg.generators = replaced;
    }
  }
}

function replaceGenerator(
  generators: FigGenerator | FigGenerator[] | undefined,
): FigGenerator | FigGenerator[] | undefined {
  if (!generators) {
    return generators;
  }
  if (Array.isArray(generators)) {
    let changed = false;
    const next = generators.map((generator) => {
      const replacement = replacementForGenerator(generator);
      if (replacement) {
        changed = true;
        return replacement;
      }
      return generator;
    });
    return changed ? next : generators;
  }
  return replacementForGenerator(generators) ?? generators;
}

function replacementForGenerator(generator: FigGenerator): FigGenerator | null {
  return isDockerJsonContainerGenerator(generator)
    ? {
        script: DOCKER_FAST_PS_SCRIPT,
        postProcess: parseDockerContainerRows,
      }
    : null;
}

function isDockerJsonContainerGenerator(generator: FigGenerator): boolean {
  return (
    Array.isArray(generator.script) &&
    generator.script.length === DOCKER_JSON_PS_SCRIPT.length &&
    generator.script.every((part, index) => part === DOCKER_JSON_PS_SCRIPT[index])
  );
}

function walkSpec(node: FigSpecNode, visit: (node: MutableFigSpecNode) => void) {
  const mutable = node as MutableFigSpecNode;
  visit(mutable);
  for (const subcommand of mutable.subcommands ?? []) {
    walkSpec(subcommand, visit);
  }
}

function cloneSpecNode(node: FigSpecNode): FigSpecNode {
  const mutable = node as MutableFigSpecNode;
  return {
    ...mutable,
    args: cloneArgList(mutable.args),
    options: mutable.options?.map((option) => ({
      ...option,
      args: cloneArgList(option.args),
    })),
    subcommands: mutable.subcommands?.map(cloneSpecNode),
  };
}

function cloneArgList<T extends FigArgNode>(args: T | T[] | undefined) {
  if (Array.isArray(args)) {
    return args.map((arg) => ({ ...arg }));
  }
  return args ? { ...args } : args;
}

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

type MutableFigSpecNode = FigSpecNode & {
  args?: FigArgNode | FigArgNode[];
  options?: FigOptionNode[];
  subcommands?: FigSpecNode[];
};

/**
 * 번들된 모듈을 스펙 노드로 다듬는다.
 *
 * **양쪽이 같은 것을 거쳐야 한다.** 데스크톱은 동적 import, 모바일은 Metro 의 require 로 모듈을
 * 가져오는데 — 가져오는 방법만 다르고 그 뒤(기본 내보내기 벗기기·오버라이드 적용)는 같아야
 * 같은 제너레이터가 돈다. 한쪽만 오버라이드를 빠뜨리면 docker 가 서로 다른 `ps` 를 부른다.
 */
export function normalizeCommandModule(
  name: string,
  module: unknown,
): FigSpecNode | null {
  if (!module) {
    return null;
  }
  const raw = ((module as { default?: unknown }).default ?? module) as FigSpecNode;
  return applyCommandModuleOverrides(name, raw);
}
