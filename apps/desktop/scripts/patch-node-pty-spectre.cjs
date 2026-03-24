const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopRoot, '../..');

const TARGET_FILES = [
  'binding.gyp',
  path.join('deps', 'winpty', 'src', 'winpty.gyp')
];

const SPECTRE_BLOCK_PATTERN = /^[ \t]*'msvs_configuration_attributes': \{\r?\n[ \t]*'SpectreMitigation': 'Spectre'\r?\n[ \t]*\},?\r?\n/gm;

function unique(values) {
  return [...new Set(values)];
}

function resolveNodePtyRoots() {
  return unique([
    path.join(desktopRoot, 'node_modules', 'node-pty'),
    path.join(repoRoot, 'node_modules', 'node-pty')
  ]).filter((candidate) => fs.existsSync(candidate));
}

function patchFile(filePath) {
  const original = fs.readFileSync(filePath, 'utf8');
  const next = original.replace(SPECTRE_BLOCK_PATTERN, '');
  if (next === original) {
    return false;
  }

  fs.writeFileSync(filePath, next, 'utf8');
  return true;
}

function patchNodePtyRoot(rootPath) {
  const changedFiles = [];

  for (const relativePath of TARGET_FILES) {
    const targetPath = path.join(rootPath, relativePath);
    if (!fs.existsSync(targetPath)) {
      continue;
    }

    if (patchFile(targetPath)) {
      changedFiles.push(targetPath);
    }
  }

  return changedFiles;
}

function main() {
  const nodePtyRoots = resolveNodePtyRoots();
  if (nodePtyRoots.length === 0) {
    console.log('node-pty package not found; skipping Spectre mitigation patch.');
    return;
  }

  const changedFiles = nodePtyRoots.flatMap((rootPath) => patchNodePtyRoot(rootPath));
  if (changedFiles.length === 0) {
    console.log('node-pty Spectre mitigation patch already applied.');
    return;
  }

  console.log(`Patched node-pty Spectre mitigation in ${changedFiles.length} file(s):`);
  for (const filePath of changedFiles) {
    console.log(`- ${filePath}`);
  }
}

main();
