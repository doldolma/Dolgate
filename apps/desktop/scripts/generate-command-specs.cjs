#!/usr/bin/env node
/*
 * Convert Fig autocomplete specs (github.com/withfig/autocomplete, MIT) into the
 * slim, static command-spec JSON consumed by the renderer's terminal
 * autocomplete. Only static subcommands/options are kept; dynamic `generators`
 * (which run shell commands) are dropped — completion is computed client-side.
 *
 * Output: apps/desktop/src/renderer/generated/command-specs/<name>.json + index.json
 *
 * Source of the Fig specs (in priority order):
 *   1. DOLSSH_FIG_AUTOCOMPLETE_DIR — path to an existing withfig/autocomplete checkout
 *   2. a shallow clone of the pinned ref into apps/desktop/.cache/fig-autocomplete
 *
 * Usage: npm run generate:specs            (seed list below)
 *        SPECS=git,docker,kubectl npm run generate:specs
 *
 * NOTE: This regenerates committed seed JSON. Scaling to the full Fig catalog
 * (3000+ specs, lazy-loaded, non-committed build output) is Stage 2 — see the
 * plan. Requires network (clone) or a local checkout, and esbuild (a Vite dep).
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FIG_REPO = 'https://github.com/withfig/autocomplete.git';
// Pin a ref for reproducible output. Update intentionally.
const FIG_REF = 'master';

// Curated set of commands commonly typed in a remote/dev terminal that benefit
// from subcommand/flag completion. Giant specs (aws, gcloud, terraform, az) are
// intentionally excluded to keep the committed JSON small. Override with SPECS=.
const DEFAULT_SEED = [
  'git', 'docker', 'docker-compose', 'kubectl', 'helm',
  'npm', 'yarn', 'pnpm', 'node', 'bun', 'deno',
  'systemctl', 'journalctl', 'ssh', 'scp', 'rsync',
  'curl', 'wget', 'tar', 'make', 'cargo', 'go',
  'python3', 'pip', 'pip3', 'brew', 'apt', 'apt-get', 'dnf',
  'grep', 'find', 'sed', 'awk', 'jq',
  'ps', 'kill', 'chmod', 'chown', 'htop', 'tmux',
  'gh', 'ansible', 'vim', 'psql', 'openssl',
  // Path-oriented commands: their file/folder templates drive `ls`-based path
  // completion (and suppress stale history paths) for cd/ls/cp/etc.
  'cd', 'ls', 'cp', 'mv', 'rm', 'mkdir', 'rmdir', 'touch',
  'cat', 'less', 'head', 'tail', 'du', 'ln', 'stat',
];

const SEED = process.env.SPECS
  ? process.env.SPECS.split(',').map((value) => value.trim()).filter(Boolean)
  : DEFAULT_SEED;

const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'src/renderer/generated/command-specs');
const modulesOutDir = path.join(repoRoot, 'src/renderer/generated/command-spec-modules');
const cacheDir = path.join(repoRoot, '.cache/fig-autocomplete');
// Aliased in for the @fig/* helper imports so spec modules bundle self-contained.
const genStub = path.join(__dirname, 'fig-generators-stub.mjs');

function resolveFigDir() {
  const override = process.env.DOLSSH_FIG_AUTOCOMPLETE_DIR;
  if (override) {
    return path.resolve(override);
  }
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
    execFileSync('git', ['clone', '--depth', '1', '--branch', FIG_REF, FIG_REPO, cacheDir], {
      stdio: 'inherit',
    });
  }
  return cacheDir;
}

function findSpecFile(figDir, name) {
  const candidates = [
    path.join(figDir, 'src', `${name}.ts`),
    path.join(figDir, 'src', name, `${name}.ts`),
    path.join(figDir, 'src', name, 'index.ts'),
  ];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

// Load a Fig spec module by bundling it to CJS with esbuild, stubbing the Fig
// runtime helpers that specs reference. Type annotations (Fig.Spec) are erased.
function loadFigSpec(esbuild, specFile) {
  const result = esbuild.buildSync({
    entryPoints: [specFile],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    // Stub helpers that would otherwise need the Fig runtime / npm packages.
    define: { 'Fig.loadSpec': 'undefined' },
    external: ['@fig/*', '@withfig/*'],
  });
  const code = result.outputFiles[0].text;
  // Recursive callable stub: specs call Fig generator helpers (e.g. ai(),
  // filepaths()) at module-load time. We discard their (dynamic) results, but
  // the calls must not throw — every property access and call returns the stub.
  const stub = new Proxy(function stub() { return stub; }, {
    get: () => stub,
    apply: () => stub,
  });
  // The filepaths()/folders() prebuilt generators carry file/folder intent we
  // want to preserve as a `template` (so `cd`/`ls`-style commands path-complete).
  // Return a tagged marker for those; everything else falls back to the stub.
  const figGenerators = {
    filepaths: (options) => ({
      __figTemplate:
        options && options.showFolders === 'only' ? 'folders' : 'filepaths',
    }),
    folders: () => ({ __figTemplate: 'folders' }),
  };
  const requireShim = (id) => {
    if (id === '@fig/autocomplete-generators' || id === '@fig/autocomplete-helpers') {
      return new Proxy(figGenerators, {
        get: (target, key) => (key in target ? target[key] : stub),
      });
    }
    return stub;
  };
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  const run = new Function('module', 'exports', 'require', code);
  run(module, module.exports, requireShim);
  return module.exports.default ?? module.exports;
}

function firstName(name) {
  return Array.isArray(name) ? name[0] : name;
}

// Fig object -> slim CommandSpec (static only). Pure; exported for testing.
function figSpecToSlim(spec, figDir, depth = 0) {
  if (!spec || typeof spec !== 'object') {
    return null;
  }
  const name = firstName(spec.name);
  if (!name) {
    return null;
  }
  const slim = { name };
  if (typeof spec.description === 'string') {
    slim.description = spec.description;
  }
  const options = toArray(spec.options)
    .map(figOptionToSlim)
    .filter(Boolean);
  if (options.length) {
    slim.options = options;
  }
  const subcommands = [];
  for (const sub of toArray(spec.subcommands)) {
    const child = figSpecToSlim(sub, figDir, depth + 1);
    if (child) {
      subcommands.push(child);
    } else if (typeof sub?.loadSpec === 'string' && figDir && depth < 4) {
      const resolved = resolveLoadSpec(sub, figDir, depth);
      if (resolved) {
        subcommands.push(resolved);
      }
    }
  }
  if (subcommands.length) {
    slim.subcommands = subcommands;
  }
  const args = toArray(spec.args).map(figArgToSlim).filter(Boolean);
  if (args.length) {
    slim.args = args;
  }
  return slim;
}

function figOptionToSlim(option) {
  if (!option || option.name == null) {
    return null;
  }
  const names = toArray(option.name).filter((value) => typeof value === 'string');
  if (!names.length) {
    return null;
  }
  const slim = { names };
  if (typeof option.description === 'string') {
    slim.description = option.description;
  }
  if (option.args != null) {
    slim.takesArg = true;
    const args = toArray(option.args).map(figArgToSlim).filter(Boolean);
    if (args.length) {
      slim.args = args;
    }
  }
  return slim;
}

// Fig arg -> slim ArgSpec. Keeps positional alignment (every object arg yields a
// slot) and preserves the two things we can complete statically: a file/folder
// `template`, and a generator whose `script` is a plain string (or string argv).
// Function scripts, prebuilt generators (filepaths()), and token interpolation
// become the load-time stub and are dropped — partial coverage by design.
function figArgToSlim(arg) {
  if (!arg || typeof arg !== 'object') {
    return null;
  }
  const slim = {};
  if (typeof arg.name === 'string') {
    slim.name = arg.name;
  }
  if (arg.isOptional === true) {
    slim.optional = true;
  }
  if (arg.isVariadic === true) {
    slim.variadic = true;
  }
  // Template comes from arg.template (e.g. ls) or a filepaths()/folders()
  // generator helper (e.g. cd uses `generators: filepaths({showFolders:'only'})`).
  const template =
    normalizeTemplate(arg.template) || templateFromGenerators(arg.generators);
  if (template) {
    slim.template = template;
  }
  // Mark args that carry a runnable generator. The generator itself is run from
  // the bundled JS module at completion time; here we only flag the slot so the
  // renderer prefers dynamic completion over the path heuristic (e.g. branch
  // names containing "/"). Template (filepaths/folders) is covered by our own
  // path completion, so a template-only arg is not flagged.
  if (!template && hasRunnableGenerator(arg.generators)) {
    slim.hasGenerator = true;
  }
  return slim;
}

// filepaths()/folders() helpers are tagged with __figTemplate by the load-time
// shim — turn that into a path template.
function templateFromGenerators(generators) {
  for (const generator of toArray(generators)) {
    if (
      generator &&
      typeof generator === 'object' &&
      (generator.__figTemplate === 'filepaths' ||
        generator.__figTemplate === 'folders')
    ) {
      return generator.__figTemplate;
    }
  }
  return undefined;
}

// A generator is runnable by us if it's a real object (not the load-time helper
// stub, which is a callable Proxy → typeof 'function') with a script/custom/
// splitOn. filepaths()/ai() helpers become the stub and are skipped (path
// completion covers files; AI is out of scope).
function hasRunnableGenerator(generators) {
  return toArray(generators).some(
    (generator) =>
      generator &&
      typeof generator === 'object' &&
      (generator.script || generator.custom || generator.splitOn),
  );
}

function normalizeTemplate(template) {
  if (!template) {
    return undefined;
  }
  const list = (Array.isArray(template) ? template : [template]).filter(
    (value) => typeof value === 'string',
  );
  const hasFiles = list.includes('filepaths');
  const hasFolders = list.includes('folders');
  if (hasFolders && !hasFiles) {
    return 'folders';
  }
  if (hasFiles || hasFolders) {
    return 'filepaths';
  }
  return undefined;
}

function resolveLoadSpec(sub, figDir, depth) {
  // loadSpec like "git/commit" -> src/git/commit.ts
  const ref = sub.loadSpec;
  const file = path.join(figDir, 'src', `${ref}.ts`);
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    const esbuild = require('esbuild');
    const loaded = loadFigSpec(esbuild, file);
    const child = figSpecToSlim(loaded, figDir, depth + 1);
    if (child && firstName(sub.name)) {
      child.name = firstName(sub.name);
    }
    return child;
  } catch {
    return null;
  }
}

function toArray(value) {
  if (value == null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

// Bundle a Fig spec to a self-contained ESM module that PRESERVES its generator
// functions (script/postProcess/custom + local helpers), for the renderer to run
// at completion time. Unlike loadFigSpec (which stubs everything to extract
// static JSON), this keeps the real functions and inlines the @fig/* helpers via
// the alias stub, so the output has no runtime dependencies. Returns module text.
function bundleSpecModule(esbuild, specFile) {
  const result = esbuild.buildSync({
    entryPoints: [specFile],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    minify: true,
    logLevel: 'silent',
    alias: {
      '@fig/autocomplete-generators': genStub,
      '@fig/autocomplete-helpers': genStub,
    },
  });
  return result.outputFiles[0].text;
}

function main() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    console.error('esbuild not found (it ships with Vite). Run from apps/desktop.');
    process.exit(1);
  }
  const figDir = resolveFigDir();
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(modulesOutDir, { recursive: true });

  const covered = [];
  const modulesCovered = [];
  for (const name of SEED) {
    const specFile = findSpecFile(figDir, name);
    if (!specFile) {
      console.warn(`! no Fig spec found for "${name}"`);
      continue;
    }
    try {
      const figSpec = loadFigSpec(esbuild, specFile);
      const slim = figSpecToSlim(figSpec, figDir);
      if (!slim) {
        console.warn(`! could not convert "${name}"`);
        continue;
      }
      slim.name = name;
      fs.writeFileSync(
        path.join(outDir, `${name}.json`),
        `${JSON.stringify(slim, null, 2)}\n`,
      );
      covered.push(name);
      console.log(`✓ ${name}`);
    } catch (error) {
      console.warn(`! failed "${name}": ${error.message}`);
    }

    // Also emit a runnable spec module (generator functions preserved) so the
    // renderer can execute dynamic generators. Failures here are non-fatal —
    // the command just won't have dynamic generators (static + path still work).
    try {
      const moduleCode = bundleSpecModule(esbuild, specFile);
      fs.writeFileSync(
        path.join(modulesOutDir, `${name}.js`),
        `// AUTO-GENERATED from withfig/autocomplete (${name}), MIT. Do not edit.\n` +
          `// Bundled Fig spec WITH generator functions for runtime use. See NOTICE.md.\n` +
          moduleCode,
      );
      modulesCovered.push(name);
    } catch (error) {
      console.warn(`! module bundle failed "${name}": ${error.message}`);
    }
  }

  // Build the index from everything on disk so partial runs (SPECS=...) don't
  // drop previously generated specs from the index.
  const present = fs
    .readdirSync(outDir)
    .filter((file) => file.endsWith('.json') && file !== 'index.json')
    .map((file) => file.replace(/\.json$/, ''))
    .sort();
  fs.writeFileSync(path.join(outDir, 'index.json'), `${JSON.stringify(present)}\n`);
  console.log(
    `\nConverted ${covered.length} this run; index now lists ${present.length} spec(s) in ${path.relative(repoRoot, outDir)}`,
  );
  console.log(
    `Bundled ${modulesCovered.length} runnable spec module(s) in ${path.relative(repoRoot, modulesOutDir)}`,
  );
}

module.exports = { figSpecToSlim, figOptionToSlim, figArgToSlim };

if (require.main === module) {
  main();
}
