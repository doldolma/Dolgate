require("react-native-gesture-handler/jestSetup");

jest.mock("@react-native-documents/picker", () => ({
  pick: jest.fn(),
  keepLocalCopy: jest.fn(),
  isErrorWithCode: jest.fn(() => false),
  errorCodes: {
    OPERATION_CANCELED: "OPERATION_CANCELED",
  },
  types: {
    allFiles: "*/*",
    plainText: "text/plain",
  },
}));

// The SSH engine's native module. Every test needs it now that the store and the
// vault reach the engine directly — previously each file mocked the russh
// package instead. Individual tests override these with their own behaviour.
const { NativeModules } = require("react-native");

NativeModules.GoSshEngineModule = NativeModules.GoSshEngineModule ?? {
  getEngineVersion: jest.fn(async () => "go-engine/test"),
  probeHostKey: jest.fn(async () =>
    JSON.stringify({
      algorithm: "ssh-ed25519",
      publicKeyBase64: "dGVzdC1ob3N0LWtleQ==",
      fingerprintSha256: "SHA256:test",
    }),
  ),
  inspectPrivateKey: jest.fn(async () => JSON.stringify({ algorithm: "ssh-ed25519" })),
  inspectCertificate: jest.fn(async () => JSON.stringify({ status: "valid" })),
  connect: jest.fn(async () => JSON.stringify({ id: "test-connection" })),
  respondKeyboardInteractive: jest.fn(async () => undefined),
  respondHostKeyTrust: jest.fn(async () => undefined),
  cancelConnect: jest.fn(async () => undefined),
  disconnect: jest.fn(async () => undefined),
  startShell: jest.fn(async () => ({ shellId: "test-shell", info: "{}" })),
  generateEphemeralSshKey: jest.fn(async () =>
    JSON.stringify({ privateKeyPem: "TEST PRIVATE KEY", publicKey: "ssh-ed25519 AAAATEST" }),
  ),
  // SSM 셸도 SSH 셸과 같은 shellId 체계로 돌아온다 — 그래서 sendData/resize/followOutput 이
  // 그대로 쓰인다. 목도 같은 모양이어야 그 사실이 테스트로 검증된다.
  startAwsSsmShell: jest.fn(async () => ({ shellId: "test-ssm-shell", info: "{}" })),
  startSsmPortForward: jest.fn(async () => ({ forwardId: "test-forward", bindPort: 54321 })),
  stopSsmPortForward: jest.fn(async () => undefined),
  sendData: jest.fn(async () => undefined),
  resize: jest.fn(async () => undefined),
  closeShell: jest.fn(async () => undefined),
  readBuffer: jest.fn(async () => ({ dataBase64: "", nextSeq: 0, hasDropped: false })),
  getShellStats: jest.fn(async () => "{}"),
  getCurrentSeq: jest.fn(async () => 0),
  followOutput: jest.fn(async () => 1),
  unfollowOutput: jest.fn(async () => undefined),
  startSftp: jest.fn(async () => "test-sftp"),
  sftpList: jest.fn(async () => JSON.stringify({ path: ".", entries: [] })),
  sftpReadChunk: jest.fn(async () => ({ dataBase64: "", eof: true })),
  sftpWriteChunk: jest.fn(async () => undefined),
  sftpMkdir: jest.fn(async () => undefined),
  sftpRename: jest.fn(async () => undefined),
  sftpChmod: jest.fn(async () => undefined),
  sftpRemove: jest.fn(async () => undefined),
  sftpStat: jest.fn(async () => "{}"),
  closeSftp: jest.fn(async () => undefined),
  configureTailnets: jest.fn(async () => undefined),
  startTailnet: jest.fn(async () => undefined),
  cancelTailnet: jest.fn(async () => undefined),
  disconnectTailnet: jest.fn(async () => undefined),
  snapshotTailnets: jest.fn(async () => undefined),
  forgetTailnet: jest.fn(async () => undefined),
  closeTailnets: jest.fn(async () => undefined),
  // Deterministic per (passphrase, salt) rather than a constant: the vault tests
  // distinguish a correct passphrase from a wrong one by whether the derived key
  // unwraps the DEK, so a fixed key would make both look identical.
  deriveArgon2idKey: jest.fn(async (passphraseBase64, saltBase64) => {
    const seed = Buffer.from(`${passphraseBase64}|${saltBase64}`, "utf8");
    const key = Buffer.alloc(32);
    for (let i = 0; i < key.length; i += 1) {
      let acc = i + 1;
      for (let j = 0; j < seed.length; j += 1) {
        acc = (acc * 31 + seed[j]) & 0xffffffff;
      }
      key[i] = acc & 0xff;
    }
    return key.toString("base64");
  }),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

// UI 문구를 단정하는 테스트는 한국어 원문을 기대한다(한국어가 소스 언어). 초기화하지 않으면
// t() 가 번역 키를 그대로 돌려줘 문구 단정이 전부 깨진다.
require("./src/i18n").initMobileI18n("ko");

// 네이티브 클립보드는 JS 테스트에 네이티브 바이너리가 없어 TurboModule 조회가 실패한다.
jest.mock('@react-native-clipboard/clipboard', () => ({
  __esModule: true,
  default: { setString: jest.fn(), getString: jest.fn(async () => '') },
}));
