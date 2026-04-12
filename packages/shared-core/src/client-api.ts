import type {
  AppTheme,
  AuthState,
  HostRecord,
  KnownHostRecord,
  LoadedManagedSecretPayload,
  SecretMetadataRecord,
  SshHostRecord,
  SyncStatus,
  TerminalTab,
} from "./models";

export interface HostSecretInput {
  password?: string;
  passphrase?: string;
  privateKeyPem?: string;
  certificateText?: string;
}

export interface ClientSessionEvent {
  type: "connected" | "closed" | "error";
  sessionId: string;
  message?: string | null;
}

export interface MobileAuthRedirectPayload {
  code: string;
  state?: string | null;
}

export interface MobileSettings {
  serverUrl: string;
  theme: AppTheme;
}

export interface MobileSessionRecord {
  id: string;
  sessionId: string;
  hostId: string;
  title: string;
  status: TerminalTab["status"];
  hasReceivedOutput: boolean;
  isRestorable: boolean;
  lastViewportSnapshot: string;
  lastEventAt: string;
  lastConnectedAt?: string | null;
  lastDisconnectedAt?: string | null;
  errorMessage?: string | null;
}

export interface ClientSshConnectInput {
  host: SshHostRecord;
  cols: number;
  rows: number;
  title?: string;
  secrets?: HostSecretInput;
}

export interface ClientApi {
  auth: {
    getState: () => Promise<AuthState>;
    beginBrowserLogin: () => Promise<void>;
    completeBrowserLogin: (
      payload: MobileAuthRedirectPayload,
    ) => Promise<AuthState>;
    refresh: () => Promise<AuthState>;
    logout: () => Promise<void>;
  };
  sync: {
    bootstrap: () => Promise<SyncStatus>;
    pushKnownHosts: (records: KnownHostRecord[]) => Promise<SyncStatus>;
    status: () => Promise<SyncStatus>;
  };
  hosts: {
    list: () => Promise<HostRecord[]>;
  };
  knownHosts: {
    list: () => Promise<KnownHostRecord[]>;
  };
  secrets: {
    list: () => Promise<SecretMetadataRecord[]>;
    load: (secretRef: string) => Promise<LoadedManagedSecretPayload | null>;
  };
  settings: {
    get: () => Promise<MobileSettings>;
    update: (input: Partial<MobileSettings>) => Promise<MobileSettings>;
  };
  sessions: {
    list: () => Promise<MobileSessionRecord[]>;
    connect: (input: ClientSshConnectInput) => Promise<{ sessionId: string }>;
    write: (sessionId: string, data: string) => Promise<void>;
    resize: (sessionId: string, cols: number, rows: number) => Promise<void>;
    disconnect: (sessionId: string) => Promise<void>;
    onEvent: (listener: (event: ClientSessionEvent) => void) => () => void;
    onData: (
      sessionId: string,
      listener: (chunk: Uint8Array) => void,
    ) => () => void;
  };
}
