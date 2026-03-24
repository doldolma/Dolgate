const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const OUTPUT_BASENAME = 'data.json';
const MODE_COLLECT = 'collect';
const MODE_NATIVE_DECRYPT = 'native-decrypt';
const DEBUG_ENABLED = process.env.DOLSSH_TERMIUS_DEBUG === '1';
const COPY_ITEMS = ['IndexedDB', 'Local Storage', 'databases', 'Local State', 'Preferences'];
const LOCAL_CREDENTIAL_KEYS = [
  'apiKey',
  'encryptionKey',
  'hmacKey',
  'encryptionSalt',
  'hmacSalt',
  'publicKey',
  'privateKey',
  'personalKey',
  'encryptedTeamKey',
  'ownerPublicKey',
  'centrifugeJWTToken',
  'centrifugeClientID'
];
const SENSITIVE_KEY_PARTS = [
  'password',
  'passphrase',
  'privatekey',
  'privatekeycontent',
  'encryptedprivatekey',
  'secret',
  'token',
  'apikey',
  'hmackey',
  'encryptionkey',
  'localkey',
  'personalkey'
];

function debugLog(message) {
  if (!DEBUG_ENABLED) {
    return;
  }

  process.stderr.write(`[dolssh-termius-helper] ${message}\n`);
}

function parseArgs(argv) {
  const options = {
    mode: MODE_COLLECT,
    inputPath: null,
    outPath: null,
    probeFile: path.join(__dirname, 'termius-probe.html')
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--native-decrypt') {
      options.mode = MODE_NATIVE_DECRYPT;
      continue;
    }

    if (arg === '--input') {
      index += 1;
      if (index >= argv.length) {
        throw new Error('--input requires a file path');
      }
      options.inputPath = path.resolve(argv[index]);
      continue;
    }

    if (arg.startsWith('--input=')) {
      options.inputPath = path.resolve(arg.slice('--input='.length));
      continue;
    }

    if (arg === '--out') {
      index += 1;
      if (index >= argv.length) {
        throw new Error('--out requires a file path');
      }
      options.outPath = resolveOutputFilePath(argv[index]);
      continue;
    }

    if (arg.startsWith('--out=')) {
      options.outPath = resolveOutputFilePath(arg.slice('--out='.length));
      continue;
    }

    if (arg === '--probe-file') {
      index += 1;
      if (index >= argv.length) {
        throw new Error('--probe-file requires a path');
      }
      options.probeFile = path.resolve(argv[index]);
      continue;
    }

    if (arg.startsWith('--probe-file=')) {
      options.probeFile = path.resolve(arg.slice('--probe-file='.length));
      continue;
    }
  }

  if (!options.outPath) {
    throw new Error('Missing required --out <path>');
  }

  if (options.mode === MODE_NATIVE_DECRYPT && !options.inputPath) {
    throw new Error('Missing required --input <path> for native decrypt mode');
  }

  return options;
}

function uniquePaths(paths) {
  const seen = new Set();
  const result = [];

  for (const candidate of paths) {
    if (!candidate) {
      continue;
    }

    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    result.push(resolved);
  }

  return result;
}

function safeReadDir(dirPath) {
  try {
    return fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (_error) {
    return [];
  }
}

function firstExistingPath(candidates) {
  for (const candidate of uniquePaths(candidates)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function buildPackagePath(resourcesRoot, packageName) {
  return path.join(resourcesRoot, 'app.asar.unpacked', 'node_modules', '@termius', packageName);
}

function toResourcesRoot(appRoot) {
  if (!appRoot) {
    return null;
  }

  const resolvedAppRoot = path.resolve(appRoot);
  const basename = path.basename(resolvedAppRoot);

  if (resolvedAppRoot.endsWith('.app')) {
    return path.join(resolvedAppRoot, 'Contents', 'Resources');
  }

  if (basename === 'Resources') {
    return resolvedAppRoot;
  }

  if (basename.toLowerCase() === 'termius.exe') {
    return path.join(path.dirname(resolvedAppRoot), 'resources');
  }

  if (basename === 'Termius' && path.basename(path.dirname(resolvedAppRoot)) === 'MacOS') {
    return path.join(path.dirname(path.dirname(resolvedAppRoot)), 'Resources');
  }

  return path.join(resolvedAppRoot, 'resources');
}

function toExecutablePath(appRoot) {
  if (!appRoot) {
    return null;
  }

  const resolvedAppRoot = path.resolve(appRoot);
  const basename = path.basename(resolvedAppRoot);

  if (process.platform === 'win32') {
    if (basename.toLowerCase() === 'termius.exe') {
      return resolvedAppRoot;
    }

    if (basename === 'Resources') {
      return path.join(path.dirname(resolvedAppRoot), 'Termius.exe');
    }

    return path.join(resolvedAppRoot, 'Termius.exe');
  }

  if (process.platform === 'darwin') {
    if (basename === 'Termius' && path.basename(path.dirname(resolvedAppRoot)) === 'MacOS') {
      return resolvedAppRoot;
    }

    if (resolvedAppRoot.endsWith('.app')) {
      return path.join(resolvedAppRoot, 'Contents', 'MacOS', path.basename(resolvedAppRoot, '.app'));
    }

    if (basename === 'Resources') {
      const contentsDir = path.dirname(resolvedAppRoot);
      const appBundleName = path.basename(path.dirname(contentsDir), '.app') || 'Termius';
      return path.join(contentsDir, 'MacOS', appBundleName);
    }
  }

  return null;
}

function collectWindowsAppCandidates() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return [path.join(localAppData, 'Programs', 'Termius')];
}

function collectWindowsDataCandidates() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return [path.join(appData, 'Termius')];
}

function collectMacAppCandidates() {
  const homeDir = os.homedir();
  const appRoots = ['/Applications', path.join(homeDir, 'Applications')];
  const candidates = [
    '/Applications/Termius.app',
    '/Applications/Setapp/Termius.app',
    path.join(homeDir, 'Applications', 'Termius.app')
  ];

  for (const root of appRoots) {
    for (const entry of safeReadDir(root)) {
      if (entry.isDirectory() && entry.name.endsWith('.app') && /termius/i.test(entry.name)) {
        candidates.push(path.join(root, entry.name));
      }
    }
  }

  return uniquePaths(candidates);
}

function collectMacDataCandidates() {
  const homeDir = os.homedir();
  const candidates = [path.join(homeDir, 'Library', 'Application Support', 'Termius')];
  const containersRoot = path.join(homeDir, 'Library', 'Containers');

  for (const entry of safeReadDir(containersRoot)) {
    if (!entry.isDirectory() || !/(termius|serverauditor)/i.test(entry.name)) {
      continue;
    }

    const appSupportRoot = path.join(containersRoot, entry.name, 'Data', 'Library', 'Application Support');
    candidates.push(path.join(appSupportRoot, 'Termius'));

    for (const nestedEntry of safeReadDir(appSupportRoot)) {
      if (nestedEntry.isDirectory() && /termius/i.test(nestedEntry.name)) {
        candidates.push(path.join(appSupportRoot, nestedEntry.name));
      }
    }
  }

  return uniquePaths(candidates);
}

function getPlatformDefaults() {
  switch (process.platform) {
    case 'win32':
      return {
        appCandidates: collectWindowsAppCandidates(),
        dataCandidates: collectWindowsDataCandidates(),
        keytarService: 'Termius'
      };
    case 'darwin':
      return {
        appCandidates: collectMacAppCandidates(),
        dataCandidates: collectMacDataCandidates(),
        keytarService: 'Termius'
      };
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
  }
}

function formatCandidatesForError(candidates) {
  return uniquePaths(candidates)
    .map((candidate) => `  - ${candidate}`)
    .join('\n');
}

function resolveTermiusRuntimeConfig(env = process.env) {
  const defaults = getPlatformDefaults();
  const appCandidates = uniquePaths([env.TERMIUS_APP_ROOT, env.TERMIUS_APP_PATH, ...defaults.appCandidates]);
  const resourceCandidates = uniquePaths(appCandidates.map(toResourcesRoot));
  const executableCandidates = env.TERMIUS_EXECUTABLE_PATH
    ? uniquePaths([env.TERMIUS_EXECUTABLE_PATH])
    : uniquePaths(appCandidates.map(toExecutablePath));
  const libCandidates = env.TERMIUS_LIB_PATH
    ? uniquePaths([env.TERMIUS_LIB_PATH])
    : resourceCandidates.map((resourcesRoot) => buildPackagePath(resourcesRoot, 'libtermius'));
  const keytarCandidates = env.TERMIUS_KEYTAR_PATH
    ? uniquePaths([env.TERMIUS_KEYTAR_PATH])
    : resourceCandidates.map((resourcesRoot) => buildPackagePath(resourcesRoot, 'keytar'));
  const dataCandidates = env.TERMIUS_DATA_DIR ? uniquePaths([env.TERMIUS_DATA_DIR]) : defaults.dataCandidates;

  const executablePath = firstExistingPath(executableCandidates);
  const libPath = firstExistingPath(libCandidates);
  const keytarPath = firstExistingPath(keytarCandidates);
  const dataDir = firstExistingPath(dataCandidates);

  if (!executablePath || !libPath || !keytarPath) {
    throw new Error(
      env.TERMIUS_LIB_PATH || env.TERMIUS_KEYTAR_PATH
        ? 'Termius native module paths were not found.'
        : ['Termius installation was not found.', 'Checked application locations:', formatCandidatesForError(appCandidates) || '  - (none)'].join('\n')
    );
  }

  if (!dataDir) {
    throw new Error(['Termius data directory was not found.', 'Checked data locations:', formatCandidatesForError(dataCandidates) || '  - (none)'].join('\n'));
  }

  return {
    executablePath,
    dataDir,
    libPath,
    keytarPath,
    keytarService: env.TERMIUS_KEYTAR_SERVICE || defaults.keytarService
  };
}

function resolveOutputFilePath(outputArg) {
  const resolvedPath = path.resolve(outputArg);
  const explicitDirectory = outputArg.endsWith(path.sep) || outputArg.endsWith('/') || outputArg.endsWith('\\');

  if (explicitDirectory) {
    return path.join(resolvedPath, OUTPUT_BASENAME);
  }

  if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
    return path.join(resolvedPath, OUTPUT_BASENAME);
  }

  if (path.extname(resolvedPath)) {
    return resolvedPath;
  }

  return path.join(resolvedPath, OUTPUT_BASENAME);
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function resetDirectory(targetDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
}

function copyIfExists(sourceRoot, destinationRoot, name) {
  const sourcePath = path.join(sourceRoot, name);

  if (!fs.existsSync(sourcePath)) {
    return false;
  }

  fs.cpSync(sourcePath, path.join(destinationRoot, name), {
    recursive: true,
    force: true
  });

  return true;
}

function snapshotProfile(sourceDir, destinationDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Termius data directory does not exist: ${sourceDir}`);
  }

  resetDirectory(destinationDir);

  const copiedItems = [];
  for (const item of COPY_ITEMS) {
    if (copyIfExists(sourceDir, destinationDir, item)) {
      copiedItems.push(item);
    }
  }

  return copiedItems;
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate()), '-', pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('');
}

function createProfileCopyDir() {
  return path.join(os.tmpdir(), `dolssh-termius-profile-${process.pid}-${formatTimestamp()}`);
}

function waitForRendererCollection(ipcMain, window) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for renderer collection'));
    }, 30000);

    ipcMain.once('collect:result', (_event, payload) => {
      clearTimeout(timeout);
      resolve(payload);
    });

    window.webContents.once('did-fail-load', (_event, code, description) => {
      clearTimeout(timeout);
      reject(new Error(`Renderer failed to load (${code}): ${description}`));
    });
  });
}

function getElectronBindings() {
  return require('electron');
}

function installHelperAppLifecycleGuard(app) {
  const preventAutoQuit = (event) => {
    event.preventDefault();
  };

  app.on('window-all-closed', preventAutoQuit);

  return () => {
    app.removeListener('window-all-closed', preventAutoQuit);
  };
}

function runChildProcess(command, args, envOverride) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: envOverride ?? process.env
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({
        code: code ?? 0,
        stdout,
        stderr
      });
    });
  });
}

function parseStoredValue(rawValue) {
  if (typeof rawValue !== 'string') {
    return rawValue;
  }

  try {
    return JSON.parse(rawValue);
  } catch (_error) {
    return rawValue;
  }
}

function buildParsedLocalStorage(entries) {
  const parsedEntries = {};

  for (const [key, value] of Object.entries(entries || {})) {
    parsedEntries[key] = parseStoredValue(value);
  }

  return parsedEntries;
}

function loadNativeModules(libPath, keytarPath) {
  const libtermius = require(libPath);
  const cryptoApi = libtermius.crypto || libtermius;
  const keytar = require(keytarPath);

  if (typeof cryptoApi.init === 'function') {
    cryptoApi.init();
  }

  return {
    cryptoApi,
    keytar
  };
}

function getCryptoError(system) {
  if (typeof system.getLastError !== 'function') {
    return '';
  }

  const lastError = system.getLastError();
  if (lastError == null || lastError === 0) {
    return '';
  }

  return ` (${String(lastError)})`;
}

function createEncryptionKeyCryptor(cryptoApi, base64Key, label) {
  const systems = cryptoApi && cryptoApi.systems;
  if (!systems || typeof systems.FromEncryptionKey !== 'function') {
    throw new Error('libtermius.crypto.systems.FromEncryptionKey is unavailable');
  }

  const system = systems.FromEncryptionKey(Buffer.from(base64Key, 'base64'));

  return {
    label,
    decryptString(ciphertext) {
      if (ciphertext == null) {
        return ciphertext;
      }

      const decryptedBuffer = system.decrypt(Buffer.from(String(ciphertext), 'base64'));
      if (!decryptedBuffer) {
        throw new Error(`${label} decryption failed${getCryptoError(system)}`);
      }

      return decryptedBuffer.toString('utf8');
    }
  };
}

async function readLocalKey({ parsedLocalStorage, keytar, keytarService, warnings }) {
  if (typeof parsedLocalStorage.localKey === 'string' && parsedLocalStorage.localKey.length > 0) {
    return {
      value: parsedLocalStorage.localKey,
      source: 'localStorage'
    };
  }

  try {
    const key = await keytar.getPassword(keytarService, 'localKey');
    if (typeof key === 'string' && key.length > 0) {
      return {
        value: key,
        source: 'keychain'
      };
    }
  } catch (error) {
    warnings.push(`Could not read localKey from "${keytarService}/localKey": ${error.message}`);
  }

  return {
    value: null,
    source: null
  };
}

function decryptStoredCredentials(parsedLocalStorage, localCryptor, warnings) {
  const decryptedCredentials = {};

  if (!localCryptor) {
    return decryptedCredentials;
  }

  for (const key of LOCAL_CREDENTIAL_KEYS) {
    const encryptedValue = parsedLocalStorage[key];
    if (typeof encryptedValue !== 'string' || encryptedValue.length === 0) {
      continue;
    }

    try {
      decryptedCredentials[key] = localCryptor.decryptString(encryptedValue);
    } catch (error) {
      warnings.push(`Could not decrypt localStorage credential "${key}": ${error.message}`);
    }
  }

  return decryptedCredentials;
}

function tryDecrypt(value, cryptors) {
  if (typeof value !== 'string' || value.length === 0) {
    return value;
  }

  for (const cryptor of cryptors) {
    try {
      return cryptor.decryptString(value);
    } catch (_error) {
      // Try the next cryptor.
    }
  }

  return value;
}

function parseStructuredValue(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return '';
  }

  try {
    return JSON.parse(trimmed);
  } catch (_error) {
    return value;
  }
}

function pickFirstDefined(values) {
  for (const value of values) {
    if (value !== undefined && value !== null) {
      return value;
    }
  }

  return null;
}

function getPathValue(source, pathExpression) {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  const pathParts = pathExpression.split('.');
  let current = source;

  for (const part of pathParts) {
    if (current == null || typeof current !== 'object' || !(part in current)) {
      return undefined;
    }

    current = current[part];
  }

  return current;
}

function getFirstPathValue(source, pathExpressions) {
  for (const pathExpression of pathExpressions) {
    const value = getPathValue(source, pathExpression);
    if (value !== undefined) {
      return value;
    }
  }

  return undefined;
}

function deepDecryptValue(value, cryptors) {
  if (Array.isArray(value)) {
    return value.map((entry) => deepDecryptValue(entry, cryptors));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, deepDecryptValue(nestedValue, cryptors)]));
  }

  return tryDecrypt(value, cryptors);
}

function buildReferenceListLookup(records, idField, localIdField) {
  const byId = new Map();
  const byLocalId = new Map();

  for (const record of records) {
    if (record[idField] != null) {
      const key = String(record[idField]);
      const list = byId.get(key) || [];
      list.push(record);
      byId.set(key, list);
    }

    if (record[localIdField] != null) {
      const key = String(record[localIdField]);
      const list = byLocalId.get(key) || [];
      list.push(record);
      byLocalId.set(key, list);
    }
  }

  return { byId, byLocalId };
}

function resolveFirstReference(reference, lookup) {
  if (!reference || !lookup) {
    return null;
  }

  if (reference.id != null) {
    const resolvedById = lookup.byId.get(String(reference.id));
    if (resolvedById && resolvedById.length > 0) {
      return resolvedById[0];
    }
  }

  if (reference.local_id != null) {
    const resolvedByLocalId = lookup.byLocalId.get(String(reference.local_id));
    if (resolvedByLocalId && resolvedByLocalId.length > 0) {
      return resolvedByLocalId[0];
    }
  }

  return null;
}

function looksLikePemBlock(value) {
  if (typeof value !== 'string') {
    return false;
  }

  const trimmed = value.trim();
  return /^-----BEGIN [A-Z0-9 ]+-----$/.test(trimmed.split(/\r?\n/, 1)[0] || '') && /-----END [A-Z0-9 ]+-----\s*$/.test(trimmed);
}

function buildLookup(records) {
  const byId = new Map();
  const byLocalId = new Map();

  for (const record of records) {
    if (record.id != null) {
      byId.set(String(record.id), record);
    }

    if (record.localId != null) {
      byLocalId.set(String(record.localId), record);
    }
  }

  return { byId, byLocalId };
}

function resolveReference(reference, lookup) {
  if (!reference || !lookup) {
    return null;
  }

  if (reference.id != null) {
    const resolvedById = lookup.byId.get(String(reference.id));
    if (resolvedById) {
      return resolvedById;
    }
  }

  if (reference.local_id != null) {
    return lookup.byLocalId.get(String(reference.local_id)) || null;
  }

  return null;
}

function assignGroupPaths(groups) {
  const lookup = buildLookup(groups);

  function computePath(group, seen = new Set()) {
    if (!group || group.path) {
      return group ? group.path : null;
    }

    const groupKey = `${group.id ?? 'local'}:${group.localId ?? 'unknown'}`;
    if (seen.has(groupKey)) {
      group.path = group.name || 'group';
      return group.path;
    }

    seen.add(groupKey);
    const parent = resolveReference(
      {
        id: group.parentGroupId,
        local_id: group.parentGroupLocalId
      },
      lookup
    );
    const groupName = group.name || 'group';

    if (!parent) {
      group.path = groupName;
    } else {
      group.path = `${computePath(parent, seen)}/${groupName}`;
    }

    seen.delete(groupKey);
    return group.path;
  }

  for (const group of groups) {
    computePath(group);
  }

  return lookup;
}

function normalizeGroup(record, cryptors) {
  const name = tryDecrypt(record.label, cryptors);
  const decryptedContent = tryDecrypt(record.content, cryptors);

  return {
    id: record.id ?? null,
    localId: record.local_id ?? null,
    name,
    path: null,
    parentGroupId: record.parent_group?.id ?? null,
    parentGroupLocalId: record.parent_group?.local_id ?? null,
    isShared: Boolean(record.is_shared),
    sharingMode: record.sharing_mode ?? null,
    credentialsMode: record.credentials_mode ?? null,
    status: record.status ?? null,
    updatedAt: record.updated_at ?? null,
    content: parseStructuredValue(decryptedContent)
  };
}

function normalizeIdentity(record, cryptors) {
  const name = tryDecrypt(record.label, cryptors);
  const username = tryDecrypt(record.username, cryptors);
  const password = tryDecrypt(record.password, cryptors);
  const decryptedContent = tryDecrypt(record.content, cryptors);

  return {
    id: record.id ?? null,
    localId: record.local_id ?? null,
    name,
    username,
    password,
    isVisible: Boolean(record.is_visible),
    isShared: Boolean(record.is_shared),
    hardwareKey: record.hardware_key ?? null,
    sshKeyId: record.ssh_key?.id ?? null,
    sshKeyLocalId: record.ssh_key?.local_id ?? null,
    status: record.status ?? null,
    updatedAt: record.updated_at ?? null,
    content: parseStructuredValue(decryptedContent)
  };
}

function normalizeStoredKey(record, cryptors, sourceStore) {
  const rawRecord = deepDecryptValue(record, cryptors);
  const name = pickFirstDefined([rawRecord.label, rawRecord.name]);
  const privateKeyContent = pickFirstDefined([
    rawRecord.private_key,
    rawRecord.private_key_content,
    rawRecord.privateKeyContent,
    rawRecord.privatekeycontent,
    rawRecord.encrypted_private_key,
    rawRecord.encryptedPrivateKey
  ]);
  const publicKeyContent = pickFirstDefined([
    rawRecord.public_key,
    rawRecord.public_key_content,
    rawRecord.publicKeyContent,
    rawRecord.publickeycontent
  ]);
  const passphrase = pickFirstDefined([rawRecord.passphrase, rawRecord.key_passphrase]);

  return {
    id: record.id ?? null,
    localId: record.local_id ?? null,
    sourceStore,
    name,
    algorithm: pickFirstDefined([rawRecord.algorithm, rawRecord.key_type, rawRecord.type]),
    passphrase,
    privateKeyContent,
    privateKeyPem: looksLikePemBlock(privateKeyContent) ? privateKeyContent : null,
    publicKeyContent,
    status: record.status ?? null,
    updatedAt: record.updated_at ?? null
  };
}

function normalizeSshConfigIdentity(record, cryptors, sourceStore) {
  const decryptedContent = tryDecrypt(record.content, cryptors);

  return {
    id: record.id ?? null,
    localId: record.local_id ?? null,
    sourceStore,
    sshConfigId: pickFirstDefined([getFirstPathValue(record, ['ssh_config.id', 'sshConfig.id']), record.ssh_config_id, record.sshConfigId]),
    sshConfigLocalId: pickFirstDefined([
      getFirstPathValue(record, ['ssh_config.local_id', 'sshConfig.localId']),
      record.ssh_config_local_id,
      record.sshConfigLocalId
    ]),
    identityId: pickFirstDefined([
      getFirstPathValue(record, ['identity.id', 'ssh_identity.id', 'sshIdentity.id']),
      record.identity_id,
      record.ssh_identity_id,
      record.identityId,
      record.sshIdentityId
    ]),
    identityLocalId: pickFirstDefined([
      getFirstPathValue(record, ['identity.local_id', 'ssh_identity.local_id', 'sshIdentity.localId']),
      record.identity_local_id,
      record.ssh_identity_local_id,
      record.identityLocalId,
      record.sshIdentityLocalId
    ]),
    isShared: Boolean(record.is_shared),
    status: record.status ?? null,
    updatedAt: record.updated_at ?? null,
    content: parseStructuredValue(decryptedContent)
  };
}

function normalizeSshConfig(record, cryptors) {
  const decryptedContent = tryDecrypt(record.content, cryptors);
  const decryptedEnvVariables = tryDecrypt(record.env_variables, cryptors);

  return {
    id: record.id ?? null,
    localId: record.local_id ?? null,
    identityId: record.identity?.id ?? null,
    identityLocalId: record.identity?.local_id ?? null,
    proxyCommand: record.proxycommand ?? null,
    startupSnippetId: record.startup_snippet?.id ?? null,
    startupSnippetLocalId: record.startup_snippet?.local_id ?? null,
    moshServerCommand: record.mosh_server_command ?? null,
    colorScheme: record.color_scheme ?? null,
    useMosh: Boolean(record.use_mosh),
    envVariables: parseStructuredValue(decryptedEnvVariables),
    charset: record.charset ?? null,
    port: record.port ?? null,
    agentForwarding: Boolean(record.agent_forwarding),
    pam: record.pam ?? null,
    isShared: Boolean(record.is_shared),
    status: record.status ?? null,
    updatedAt: record.updated_at ?? null,
    content: parseStructuredValue(decryptedContent)
  };
}

function resolveIdentityForSshConfig(sshConfig, context) {
  if (!sshConfig) {
    return null;
  }

  const directIdentity = resolveReference(
    {
      id: sshConfig.identityId,
      local_id: sshConfig.identityLocalId
    },
    context.identityLookup
  );
  if (directIdentity) {
    return directIdentity;
  }

  const identityRelation = resolveFirstReference(
    {
      id: sshConfig.id,
      local_id: sshConfig.localId
    },
    context.sshConfigIdentityLookup
  );
  if (!identityRelation) {
    return null;
  }

  return resolveReference(
    {
      id: identityRelation.identityId,
      local_id: identityRelation.identityLocalId
    },
    context.identityLookup
  );
}

function normalizeHost(record, context) {
  const name = tryDecrypt(record.label, context.cryptors);
  const address = tryDecrypt(record.address, context.cryptors);
  const decryptedContent = tryDecrypt(record.content, context.cryptors);
  const group = resolveReference(record.group, context.groupLookup);
  const sshConfig = resolveReference(record.ssh_config, context.sshConfigLookup);
  const identity = resolveIdentityForSshConfig(sshConfig, context);

  return {
    id: record.id ?? null,
    localId: record.local_id ?? null,
    name,
    address,
    osName: record.os_name ?? null,
    ipVersion: record.ip_version ?? null,
    backspace: record.backspace ?? null,
    icon: record.icon ?? null,
    credentialsMode: record.credentials_mode ?? null,
    interactionDate: record.interaction_date ?? null,
    isShared: Boolean(record.is_shared),
    status: record.status ?? null,
    updatedAt: record.updated_at ?? null,
    groupId: group?.id ?? record.group?.id ?? null,
    groupLocalId: group?.localId ?? record.group?.local_id ?? null,
    groupName: group?.name ?? null,
    groupPath: group?.path ?? null,
    sshConfigId: sshConfig?.id ?? record.ssh_config?.id ?? null,
    sshConfigLocalId: sshConfig?.localId ?? record.ssh_config?.local_id ?? null,
    sshConfig,
    identity,
    content: parseStructuredValue(decryptedContent)
  };
}

function isSensitiveKey(key) {
  const normalizedKey = key.replace(/[^a-z0-9]/gi, '').toLowerCase();
  return SENSITIVE_KEY_PARTS.some((part) => normalizedKey.includes(part));
}

function redactSensitiveValues(value) {
  if (Array.isArray(value)) {
    return value.map(redactSensitiveValues);
  }

  if (value && typeof value === 'object') {
    const redactedEntries = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      redactedEntries[key] = isSensitiveKey(key) ? '***REDACTED***' : redactSensitiveValues(nestedValue);
    }

    return redactedEntries;
  }

  return value;
}

function buildExportBundle({ rendererPayload, dataDir, copiedProfileDir, keytarService, localKeySource }) {
  const parsedLocalStorage = buildParsedLocalStorage(rendererPayload.localStorageEntries);
  const warnings = [...(rendererPayload.warnings || [])];

  return {
    parsedLocalStorage,
    warnings,
    baseMeta: {
      exportedAt: new Date().toISOString(),
      termiusDataDir: dataDir,
      copiedProfileDir,
      keytarService,
      encryptionSchema: parsedLocalStorage.encryptionSchema ?? null,
      localKeyVault: parsedLocalStorage.local_key_vault ?? null,
      localKeySource,
      databases: rendererPayload.databases || []
    }
  };
}

async function collectRendererPayload({ dataDir, profileCopyDir, probeFile }) {
  const { app, BrowserWindow, ipcMain } = getElectronBindings();
  debugLog(`collect start dataDir=${dataDir} profileCopyDir=${profileCopyDir}`);
  const copiedItems = snapshotProfile(dataDir, profileCopyDir);
  app.setPath('userData', profileCopyDir);

  await app.whenReady();
  debugLog(`electron ready copiedItems=${copiedItems.join(',')}`);

  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  try {
    debugLog(`loading probe file ${probeFile}`);
    await window.loadFile(probeFile);
    debugLog('probe file loaded');
    const rendererPayload = await waitForRendererCollection(ipcMain, window);
    debugLog(
      `renderer payload received stores=${Object.keys(rendererPayload?.stores || {}).join(',')} warnings=${(rendererPayload?.warnings || []).length}`
    );
    if (rendererPayload.error) {
      throw new Error(rendererPayload.error);
    }

    return {
      copiedItems,
      rendererPayload
    };
  } finally {
    if (!window.isDestroyed()) {
      window.destroy();
    }
  }
}

async function exportTermiusDataFromRendererPayload({
  copiedItems,
  dataDir,
  profileCopyDir,
  rendererPayload,
  cryptoApi,
  keytar,
  keytarService
}) {
  const bundle = buildExportBundle({
    rendererPayload,
    dataDir,
    copiedProfileDir: profileCopyDir,
    keytarService,
    localKeySource: null
  });

  const localKeyResult = await readLocalKey({
    parsedLocalStorage: bundle.parsedLocalStorage,
    keytar,
    keytarService,
    warnings: bundle.warnings
  });

  let localCryptor = null;
  if (localKeyResult.value) {
    localCryptor = createEncryptionKeyCryptor(cryptoApi, localKeyResult.value, 'local');
  } else {
    bundle.warnings.push('localKey is unavailable; encrypted fields may remain unreadable.');
  }

  const decryptedCredentials = decryptStoredCredentials(bundle.parsedLocalStorage, localCryptor, bundle.warnings);

  const storeCryptors = [];
  if (localCryptor) {
    storeCryptors.push(localCryptor);
  }

  if (typeof decryptedCredentials.personalKey === 'string' && decryptedCredentials.personalKey.length > 0) {
    try {
      storeCryptors.push(createEncryptionKeyCryptor(cryptoApi, decryptedCredentials.personalKey, 'personal'));
    } catch (error) {
      bundle.warnings.push(`Could not initialize personal cryptor: ${error.message}`);
    }
  }

  const groups = (rendererPayload.stores.groups?.records || []).map((record) => normalizeGroup(record, storeCryptors));
  const groupLookup = assignGroupPaths(groups);

  const keys = (rendererPayload.stores.keys?.records || []).map((record) => normalizeStoredKey(record, storeCryptors, 'keys'));
  const keyLookup = buildLookup(keys);

  const multiKeys = (rendererPayload.stores.multi_keys?.records || []).map((record) => normalizeStoredKey(record, storeCryptors, 'multi_keys'));
  const multiKeyLookup = buildLookup(multiKeys);

  const identities = (rendererPayload.stores.ssh_identities?.records || [])
    .map((record) => normalizeIdentity(record, storeCryptors))
    .map((identity) => ({
      ...identity,
      sshKey:
        resolveReference(
          {
            id: identity.sshKeyId,
            local_id: identity.sshKeyLocalId
          },
          keyLookup
        ) ||
        resolveReference(
          {
            id: identity.sshKeyId,
            local_id: identity.sshKeyLocalId
          },
          multiKeyLookup
        )
    }));
  const identityLookup = buildLookup(identities);

  const sshConfigs = (rendererPayload.stores.ssh_configs?.records || []).map((record) => normalizeSshConfig(record, storeCryptors));
  const sshConfigLookup = buildLookup(sshConfigs);
  const sshConfigIdentities = [
    ...(rendererPayload.stores.ssh_config_identities?.records || []).map((record) =>
      normalizeSshConfigIdentity(record, storeCryptors, 'ssh_config_identities')
    ),
    ...(rendererPayload.stores.ssh_config_identities_shared?.records || []).map((record) =>
      normalizeSshConfigIdentity(record, storeCryptors, 'ssh_config_identities_shared')
    )
  ];
  const sshConfigIdentityLookup = buildReferenceListLookup(sshConfigIdentities, 'sshConfigId', 'sshConfigLocalId');

  const hosts = (rendererPayload.stores.hosts?.records || []).map((record) =>
    normalizeHost(record, {
      cryptors: storeCryptors,
      groupLookup,
      identityLookup,
      sshConfigIdentityLookup,
      sshConfigLookup
    })
  );

  return {
    meta: {
      ...bundle.baseMeta,
      localKeySource: localKeyResult.source,
      copiedItems,
      counts: {
        groups: groups.length,
        hosts: hosts.length,
        keys: keys.length,
        multiKeys: multiKeys.length,
        sshConfigs: sshConfigs.length,
        sshConfigIdentities: sshConfigIdentities.length,
        identities: identities.length
      },
      warnings: bundle.warnings
    },
    groups,
    hosts,
    keys,
    multiKeys,
    sshConfigs,
    sshConfigIdentities,
    identities,
    redactedPreview: redactSensitiveValues({
      groups,
      hosts,
      keys,
      multiKeys,
      sshConfigs,
      sshConfigIdentities,
      identities
    })
  };
}

function writeFile(targetPath, content) {
  ensureDirectory(path.dirname(targetPath));
  fs.writeFileSync(targetPath, content, 'utf8');
}

async function runNativeDecryptHelper(executablePath, inputPath, outputPath) {
  debugLog(`native decrypt start executable=${executablePath}`);
  const result = await runChildProcess(
    executablePath,
    [__filename, '--native-decrypt', '--input', inputPath, '--out', outputPath],
    {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1'
    }
  );

  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'Termius native decrypt helper failed.');
  }

  debugLog(`native decrypt done output=${outputPath}`);
}

async function runTermiusNativeDecryptHelper(options) {
  debugLog(`native mode start input=${options.inputPath} out=${options.outPath}`);
  const input = JSON.parse(fs.readFileSync(options.inputPath, 'utf8'));
  const { cryptoApi, keytar } = loadNativeModules(input.libPath, input.keytarPath);
  const payload = await exportTermiusDataFromRendererPayload({
    copiedItems: input.copiedItems,
    dataDir: input.dataDir,
    profileCopyDir: input.profileCopyDir,
    rendererPayload: input.rendererPayload,
    cryptoApi,
    keytar,
    keytarService: input.keytarService
  });

  writeFile(options.outPath, `${JSON.stringify(payload, null, 2)}\n`);
  debugLog(`native mode wrote output=${options.outPath}`);
}

async function runTermiusHelper(argv = process.argv.slice(1)) {
  const options = parseArgs(argv);
  debugLog(`helper start mode=${options.mode} out=${options.outPath}`);
  if (options.mode === MODE_NATIVE_DECRYPT) {
    await runTermiusNativeDecryptHelper(options);
    return;
  }

  const { app } = getElectronBindings();
  const disposeLifecycleGuard = installHelperAppLifecycleGuard(app);
  const runtimeConfig = resolveTermiusRuntimeConfig(process.env);
  const profileCopyDir = createProfileCopyDir();
  const nativeDecryptInputPath = path.join(profileCopyDir, 'native-decrypt-input.json');

  try {
    const { copiedItems, rendererPayload } = await collectRendererPayload({
      dataDir: runtimeConfig.dataDir,
      profileCopyDir,
      probeFile: options.probeFile
    });

    debugLog(`writing native decrypt input=${nativeDecryptInputPath}`);
    writeFile(
      nativeDecryptInputPath,
      `${JSON.stringify(
        {
          copiedItems,
          dataDir: runtimeConfig.dataDir,
          profileCopyDir,
          rendererPayload,
          libPath: runtimeConfig.libPath,
          keytarPath: runtimeConfig.keytarPath,
          keytarService: runtimeConfig.keytarService
        },
        null,
        2
      )}\n`
    );

    await runNativeDecryptHelper(runtimeConfig.executablePath, nativeDecryptInputPath, options.outPath);
  } finally {
    disposeLifecycleGuard();
    debugLog(`cleanup profileCopyDir=${profileCopyDir}`);
    try {
      fs.rmSync(profileCopyDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      debugLog(`cleanup skipped: ${message}`);
    }
  }

  app.exit(0);
}

module.exports = {
  runTermiusHelper
};

if (require.main === module) {
  runTermiusHelper().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    try {
      const { app } = getElectronBindings();
      app.exit(1);
    } catch {
      process.exitCode = 1;
    }
  });
}
