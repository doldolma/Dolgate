import { BrowserWindow, app } from 'electron';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  HostKeyProbeResult,
  CoreEvent,
  CoreEventType,
  CoreRequest,
  CoreStreamFrame,
  DirectoryListing,
  FileEntry,
  PortForwardMode,
  PortForwardRuntimeEvent,
  PortForwardRuntimeRecord,
  ResolvedCoreConnectPayload,
  ResolvedHostKeyProbePayload,
  ResolvedPortForwardStartPayload,
  ResolvedSftpConnectPayload,
  SftpDeleteInput,
  SftpEndpointSummary,
  SftpListInput,
  SftpMkdirInput,
  SftpRenameInput,
  TerminalTab,
  TransferJob,
  TransferJobEvent,
  TransferStartInput
} from '@shared';
import { ipcChannels } from '../common/ipc-channels';
import { CoreFrameParser, encodeControlFrame, encodeStreamFrame } from './core-framing';

interface ActivityLogInput {
  level: 'info' | 'warn' | 'error';
  category: 'ssh' | 'sftp' | 'forwarding' | 'known_hosts' | 'keychain';
  message: string;
  metadata?: Record<string, unknown> | null;
}

interface PortForwardDefinition {
  ruleId: string;
  hostId: string;
  mode: PortForwardMode;
  bindAddress: string;
  bindPort: number;
}

function resolveRepoRoot(): string {
  // 패키징/개발 환경 모두에서 저장소 루트를 계산하기 위한 단순 기준점이다.
  return path.resolve(app.getAppPath(), '../..');
}

function resolveBundledCorePath(): string {
  const binaryName = process.platform === 'win32' ? 'ssh-core.exe' : 'ssh-core';
  return path.join(process.resourcesPath, 'bin', binaryName);
}

function resolveCoreLaunchConfig(): { command: string; args: string[]; cwd: string } {
  if (app.isPackaged) {
    const bundledCorePath = resolveBundledCorePath();
    if (!existsSync(bundledCorePath)) {
      throw new Error(`Bundled ssh-core binary not found: ${bundledCorePath}`);
    }
    return {
      command: bundledCorePath,
      args: [],
      cwd: path.dirname(bundledCorePath)
    };
  }

  const repoRoot = resolveRepoRoot();
  const serviceDir = path.join(repoRoot, 'services', 'ssh-core');
  if (!existsSync(serviceDir)) {
    throw new Error(`SSH core directory not found: ${serviceDir}`);
  }

  return {
    command: 'go',
    args: ['run', './cmd/ssh-core'],
    cwd: serviceDir
  };
}

interface PendingResponse<TPayload> {
  resolve: (payload: TPayload) => void;
  reject: (error: Error) => void;
  expectedTypes: Set<CoreEventType>;
  timeout: NodeJS.Timeout;
}

function isTransferEvent(type: CoreEventType): boolean {
  return type === 'sftpTransferProgress' || type === 'sftpTransferCompleted' || type === 'sftpTransferFailed' || type === 'sftpTransferCancelled';
}

function toDirectoryListing(payload: Record<string, unknown>): DirectoryListing {
  return {
    path: String(payload.path ?? '/'),
    entries: Array.isArray(payload.entries)
      ? payload.entries.map((entry) => {
          const candidate = entry as Record<string, unknown>;
          return {
            name: String(candidate.name ?? ''),
            path: String(candidate.path ?? ''),
            isDirectory: Boolean(candidate.isDirectory),
            size: Number(candidate.size ?? 0),
            mtime: String(candidate.mtime ?? new Date(0).toISOString()),
            kind:
              candidate.kind === 'folder' || candidate.kind === 'file' || candidate.kind === 'symlink' || candidate.kind === 'unknown'
                ? candidate.kind
                : 'unknown',
            permissions: candidate.permissions ? String(candidate.permissions) : undefined
          } satisfies FileEntry;
        })
      : []
  };
}

function toTransferJobEvent(existing: TransferJob | undefined, event: CoreEvent<Record<string, unknown>>): TransferJobEvent {
  const payload = event.payload;
  const now = new Date().toISOString();
  const nextStatus =
    event.type === 'sftpTransferCompleted'
      ? 'completed'
      : event.type === 'sftpTransferFailed'
        ? 'failed'
        : event.type === 'sftpTransferCancelled'
          ? 'cancelled'
          : 'running';

  return {
    job: {
      id: event.jobId ?? existing?.id ?? '',
      sourceLabel: existing?.sourceLabel ?? 'Unknown',
      targetLabel: existing?.targetLabel ?? 'Unknown',
      itemCount: existing?.itemCount ?? 0,
      bytesTotal: Number(payload.bytesTotal ?? existing?.bytesTotal ?? 0),
      bytesCompleted: Number(payload.bytesCompleted ?? existing?.bytesCompleted ?? 0),
      speedBytesPerSecond:
        typeof payload.speedBytesPerSecond === 'number' ? payload.speedBytesPerSecond : existing?.speedBytesPerSecond,
      etaSeconds: typeof payload.etaSeconds === 'number' ? payload.etaSeconds : existing?.etaSeconds,
      status: nextStatus,
      startedAt: existing?.startedAt ?? now,
      updatedAt: now,
      activeItemName: payload.activeItemName ? String(payload.activeItemName) : existing?.activeItemName,
      errorMessage: payload.message ? String(payload.message) : existing?.errorMessage,
      request: existing?.request
    }
  };
}

export class CoreManager {
  constructor(private readonly appendLog?: (entry: ActivityLogInput) => void) {}

  // Go SSH 코어는 앱 전체에서 하나만 띄우고, 여러 SSH/SFTP 작업을 그 안에서 관리한다.
  private process: ChildProcessWithoutNullStreams | null = null;
  private shutdownPromise: Promise<void> | null = null;
  private isShuttingDown = false;
  private readonly windows = new Set<BrowserWindow>();
  private readonly tabs = new Map<string, TerminalTab>();
  private readonly sftpEndpoints = new Map<string, SftpEndpointSummary>();
  private readonly transferJobs = new Map<string, TransferJob>();
  private readonly portForwardDefinitions = new Map<string, PortForwardDefinition>();
  private readonly portForwardRuntimes = new Map<string, PortForwardRuntimeRecord>();
  private readonly pendingResponses = new Map<string, PendingResponse<Record<string, unknown>>>();
  private readonly lastResizeBySession = new Map<string, { cols: number; rows: number }>();
  // 바이너리 frame은 청크 경계를 보장하지 않으므로 별도 parser가 필요하다.
  private readonly parser = new CoreFrameParser();

  registerWindow(window: BrowserWindow): void {
    this.windows.add(window);
    window.on('closed', () => {
      this.windows.delete(window);
    });
  }

  listTabs(): TerminalTab[] {
    return Array.from(this.tabs.values());
  }

  listPortForwardRuntimes(): PortForwardRuntimeRecord[] {
    return Array.from(this.portForwardRuntimes.values()).sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    if (!this.process) {
      this.clearRuntimeState();
      return;
    }

    const currentProcess = this.process;
    this.isShuttingDown = true;
    this.shutdownPromise = new Promise((resolve) => {
      const finish = () => {
        this.clearRuntimeState();
        this.process = null;
        this.isShuttingDown = false;
        this.shutdownPromise = null;
        resolve();
      };

      const timeout = setTimeout(() => {
        if (currentProcess.exitCode === null && !currentProcess.killed) {
          currentProcess.kill('SIGKILL');
        }
      }, 1500);

      currentProcess.once('exit', () => {
        clearTimeout(timeout);
        finish();
      });

      currentProcess.stdin.end();
      if (currentProcess.exitCode === null && !currentProcess.killed) {
        currentProcess.kill('SIGTERM');
      }
    });

    return this.shutdownPromise;
  }

  async start(): Promise<void> {
    // 이미 실행 중이면 중복 spawn을 막고 기존 프로세스를 재사용한다.
    if (this.process) {
      return;
    }

    const launchConfig = resolveCoreLaunchConfig();

    this.process = spawn(launchConfig.command, launchConfig.args, {
      cwd: launchConfig.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });

    // stdout은 control + raw stream이 섞인 framed binary 채널이다.
    this.process.stdout.on('data', (chunk: Buffer) => {
      this.consumeStdout(chunk);
    });

    // stderr는 운영 중 진단 메시지를 위해 별도 error 이벤트로 내린다.
    this.process.stderr.setEncoding('utf8');
    this.process.stderr.on('data', (chunk: string) => {
      this.broadcastTerminalEvent({
        type: 'error',
        payload: {
          message: chunk.trim() || 'SSH core error'
        }
      });
    });

    this.process.on('exit', (code, signal) => {
      const message = `SSH core exited (code=${code ?? 'null'}, signal=${signal ?? 'null'})`;
      if (!this.isShuttingDown) {
        for (const sessionId of this.tabs.keys()) {
          this.broadcastTerminalEvent({
            type: 'closed',
            sessionId,
            payload: {
              message
            }
          });
        }
        for (const [jobId, existing] of this.transferJobs.entries()) {
          this.broadcastTransferEvent({
            job: {
              ...existing,
              status: 'failed',
              updatedAt: new Date().toISOString(),
              errorMessage: message
            }
          });
        }
        for (const runtime of this.portForwardRuntimes.values()) {
          this.broadcastPortForwardEvent({
            runtime: {
              ...runtime,
              status: 'error',
              updatedAt: new Date().toISOString(),
              message
            }
          });
        }
        this.broadcastTerminalEvent({
          type: 'status',
          payload: {
            status: 'stopped',
            message
          }
        });
      }
      this.rejectAllPending(message);
      this.clearRuntimeState();
      this.process = null;
      this.isShuttingDown = false;
    });
  }

  async connect(payload: ResolvedCoreConnectPayload & { title: string; hostId: string }): Promise<{ sessionId: string }> {
    await this.start();
    // 세션 ID는 Electron 쪽에서 먼저 발급해서 탭과 SSH 세션을 동일한 식별자로 묶는다.
    const sessionId = randomUUID();
    this.tabs.set(sessionId, {
      id: sessionId,
      title: payload.title,
      hostId: payload.hostId,
      sessionId,
      status: 'connecting',
      lastEventAt: new Date().toISOString()
    });
    this.sendControl<ResolvedCoreConnectPayload>({
      id: randomUUID(),
      type: 'connect',
      sessionId,
      payload
    });
    return { sessionId };
  }

  async probeHostKey(payload: ResolvedHostKeyProbePayload): Promise<HostKeyProbeResult> {
    await this.start();
    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: 'probeHostKey',
        payload
      },
      ['hostKeyProbed']
    );
    return {
      hostId: '',
      hostLabel: '',
      host: payload.host,
      port: payload.port,
      algorithm: String(response.algorithm ?? ''),
      publicKeyBase64: String(response.publicKeyBase64 ?? ''),
      fingerprintSha256: String(response.fingerprintSha256 ?? ''),
      status: 'untrusted',
      existing: null
    };
  }

  async startPortForward(payload: ResolvedPortForwardStartPayload & { ruleId: string; hostId: string }): Promise<PortForwardRuntimeRecord> {
    await this.start();
    const baseRuntime: PortForwardRuntimeRecord = {
      ruleId: payload.ruleId,
      hostId: payload.hostId,
      mode: payload.mode,
      bindAddress: payload.bindAddress,
      bindPort: payload.bindPort,
      status: 'starting',
      updatedAt: new Date().toISOString()
    };
    this.portForwardDefinitions.set(payload.ruleId, {
      ruleId: payload.ruleId,
      hostId: payload.hostId,
      mode: payload.mode,
      bindAddress: payload.bindAddress,
      bindPort: payload.bindPort
    });
    this.portForwardRuntimes.set(payload.ruleId, baseRuntime);
    this.broadcastPortForwardEvent({ runtime: baseRuntime });

    const response = await this.requestResponse<Record<string, unknown>>(
      {
        id: randomUUID(),
        type: 'portForwardStart',
        endpointId: payload.ruleId,
        payload
      },
      ['portForwardStarted']
    );

    const runtime = this.buildForwardRuntime(payload.ruleId, response, 'running');
    this.portForwardRuntimes.set(payload.ruleId, runtime);
    this.broadcastPortForwardEvent({ runtime });
    return runtime;
  }

  async stopPortForward(ruleId: string): Promise<void> {
    if (!this.process) {
      this.portForwardDefinitions.delete(ruleId);
      this.portForwardRuntimes.delete(ruleId);
      return;
    }
    await this.start();
    await this.requestResponse(
      {
        id: randomUUID(),
        type: 'portForwardStop',
        endpointId: ruleId,
        payload: {}
      },
      ['portForwardStopped']
    );
    this.portForwardDefinitions.delete(ruleId);
    const runtime = this.portForwardRuntimes.get(ruleId);
    if (runtime) {
      this.portForwardRuntimes.set(ruleId, {
        ...runtime,
        status: 'stopped',
        updatedAt: new Date().toISOString(),
        message: undefined
      });
      this.broadcastPortForwardEvent({ runtime: this.portForwardRuntimes.get(ruleId)! });
    }
  }

  async sftpConnect(payload: ResolvedSftpConnectPayload & { title: string; hostId: string }): Promise<SftpEndpointSummary> {
    await this.start();
    const endpointId = randomUUID();
    const requestId = randomUUID();
    const response = await this.requestResponse<{ path: string }>(
      {
        id: requestId,
        type: 'sftpConnect',
        endpointId,
        payload
      },
      ['sftpConnected']
    );

    const summary: SftpEndpointSummary = {
      id: endpointId,
      kind: 'remote',
      hostId: payload.hostId,
      title: payload.title,
      path: String(response.path ?? '/'),
      connectedAt: new Date().toISOString()
    };
    this.sftpEndpoints.set(endpointId, summary);
    this.log({
      level: 'info',
      category: 'sftp',
      message: 'SFTP 연결이 시작되었습니다.',
      metadata: {
        endpointId,
        hostId: payload.hostId,
        title: payload.title
      }
    });
    return summary;
  }

  async sftpDisconnect(endpointId: string): Promise<void> {
    if (!this.sftpEndpoints.has(endpointId)) {
      return;
    }
    await this.start();
    await this.requestResponse(
      {
        id: randomUUID(),
        type: 'sftpDisconnect',
        endpointId,
        payload: {}
      },
      ['sftpDisconnected']
    );
    this.sftpEndpoints.delete(endpointId);
    this.log({
      level: 'info',
      category: 'sftp',
      message: 'SFTP 연결이 종료되었습니다.',
      metadata: { endpointId }
    });
  }

  async sftpList(input: SftpListInput): Promise<DirectoryListing> {
    await this.start();
    const response = await this.requestResponse(
      {
        id: randomUUID(),
        type: 'sftpList',
        endpointId: input.endpointId,
        payload: {
          path: input.path
        }
      },
      ['sftpListed']
    );

    const listing = toDirectoryListing(response);
    const endpoint = this.sftpEndpoints.get(input.endpointId);
    if (endpoint) {
      this.sftpEndpoints.set(input.endpointId, {
        ...endpoint,
        path: listing.path
      });
    }
    return listing;
  }

  async sftpMkdir(input: SftpMkdirInput): Promise<void> {
    await this.start();
    await this.requestResponse(
      {
        id: randomUUID(),
        type: 'sftpMkdir',
        endpointId: input.endpointId,
        payload: input
      },
      ['sftpAck']
    );
  }

  async sftpRename(input: SftpRenameInput): Promise<void> {
    await this.start();
    await this.requestResponse(
      {
        id: randomUUID(),
        type: 'sftpRename',
        endpointId: input.endpointId,
        payload: input
      },
      ['sftpAck']
    );
  }

  async sftpDelete(input: SftpDeleteInput): Promise<void> {
    await this.start();
    await this.requestResponse(
      {
        id: randomUUID(),
        type: 'sftpDelete',
        endpointId: input.endpointId,
        payload: input
      },
      ['sftpAck']
    );
  }

  async startSftpTransfer(input: TransferStartInput): Promise<TransferJob> {
    await this.start();
    const jobId = randomUUID();
    const now = new Date().toISOString();
    const job: TransferJob = {
      id: jobId,
      sourceLabel: this.describeTransferEndpoint(input.source),
      targetLabel: this.describeTransferEndpoint(input.target),
      itemCount: input.items.length,
      bytesTotal: input.items.reduce((sum, item) => sum + item.size, 0),
      bytesCompleted: 0,
      status: 'queued',
      startedAt: now,
      updatedAt: now,
      request: input
    };
    this.transferJobs.set(jobId, job);
    this.broadcastTransferEvent({ job });
    this.sendControl({
      id: randomUUID(),
      type: 'sftpTransferStart',
      jobId,
      payload: input
    });
    return job;
  }

  async cancelSftpTransfer(jobId: string): Promise<void> {
    if (!this.transferJobs.has(jobId)) {
      return;
    }
    await this.start();
    this.sendControl({
      id: randomUUID(),
      type: 'sftpTransferCancel',
      jobId,
      payload: {}
    });
  }

  write(sessionId: string, data: string): void {
    const tab = this.tabs.get(sessionId);
    // 아직 연결이 성립되지 않은 탭의 입력은 코어로 보내지 않아 "session not found" 오류를 막는다.
    if (!tab || tab.status !== 'connected') {
      return;
    }
    this.sendStream(
      {
        type: 'write',
        sessionId
      },
      Buffer.from(data, 'utf8')
    );
  }

  writeBinary(sessionId: string, data: Uint8Array): void {
    const tab = this.tabs.get(sessionId);
    // 마우스 보고 등 raw 입력도 연결 완료 이후에만 전달한다.
    if (!tab || tab.status !== 'connected') {
      return;
    }
    this.sendStream(
      {
        type: 'write',
        sessionId
      },
      data
    );
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const tab = this.tabs.get(sessionId);
    // 연결 전/실패 세션에는 resize를 보내지 않아 불필요한 오류 이벤트를 만들지 않는다.
    if (!tab || tab.status !== 'connected') {
      return;
    }
    // 숨겨진 패널이나 과도한 observer 발화로 들어온 무효/중복 resize는 main에서 한 번 더 걸러준다.
    if (cols <= 0 || rows <= 0) {
      return;
    }
    const lastSize = this.lastResizeBySession.get(sessionId);
    if (lastSize?.cols === cols && lastSize.rows === rows) {
      return;
    }
    this.lastResizeBySession.set(sessionId, { cols, rows });
    this.sendControl({
      id: randomUUID(),
      type: 'resize',
      sessionId,
      payload: { cols, rows }
    });
  }

  disconnect(sessionId: string): void {
    this.lastResizeBySession.delete(sessionId);
    const tab = this.tabs.get(sessionId);
    if (!tab) {
      return;
    }
    // 코어에 실제 세션 핸들이 없을 수 있는 connecting/error 탭은 로컬에서 바로 닫아준다.
    if (!this.process || tab.status !== 'connected') {
      this.tabs.delete(sessionId);
      this.broadcastTerminalEvent({
        type: 'closed',
        sessionId,
        payload: {
          message: 'client requested disconnect'
        }
      });
      return;
    }
    this.sendControl({
      id: randomUUID(),
      type: 'disconnect',
      sessionId,
      payload: {}
    });
  }

  private consumeStdout(chunk: Buffer): void {
    for (const frame of this.parser.push(chunk)) {
      if (frame.kind === 'control') {
        this.handleControlEvent(frame.metadata);
        continue;
      }
      this.broadcastStream(frame.metadata, frame.payload);
    }
  }

  private handleControlEvent(event: CoreEvent<Record<string, unknown>>): void {
    this.resolvePendingResponse(event);

    if (isTransferEvent(event.type)) {
      const existing = event.jobId ? this.transferJobs.get(event.jobId) : undefined;
      const next = toTransferJobEvent(existing, event);
      this.transferJobs.set(next.job.id, next.job);
      this.broadcastTransferEvent(next);
      if (next.job.status === 'completed') {
        this.log({
          level: 'info',
          category: 'sftp',
          message: '파일 전송이 완료되었습니다.',
          metadata: { jobId: next.job.id, itemCount: next.job.itemCount }
        });
      } else if (next.job.status === 'failed') {
        this.log({
          level: 'error',
          category: 'sftp',
          message: '파일 전송에 실패했습니다.',
          metadata: { jobId: next.job.id, errorMessage: next.job.errorMessage ?? null }
        });
      } else if (next.job.status === 'cancelled') {
        this.log({
          level: 'warn',
          category: 'sftp',
          message: '파일 전송이 취소되었습니다.',
          metadata: { jobId: next.job.id }
        });
      }
      if (next.job.status === 'completed' || next.job.status === 'failed' || next.job.status === 'cancelled') {
        this.transferJobs.set(next.job.id, next.job);
      }
      return;
    }

    if (event.type === 'portForwardStarted' || event.type === 'portForwardStopped' || event.type === 'portForwardError') {
      const ruleId = event.endpointId ?? '';
      const status = event.type === 'portForwardStarted' ? 'running' : event.type === 'portForwardStopped' ? 'stopped' : 'error';
      const runtime = this.buildForwardRuntime(ruleId, event.payload, status);
      if (status === 'stopped') {
        this.portForwardDefinitions.delete(ruleId);
      }
      this.portForwardRuntimes.set(ruleId, runtime);
      this.broadcastPortForwardEvent({ runtime });
      if (status === 'running') {
        this.log({
          level: 'info',
          category: 'forwarding',
          message: '포트 포워딩이 시작되었습니다.',
          metadata: {
            ruleId,
            bindAddress: runtime.bindAddress,
            bindPort: runtime.bindPort,
            mode: runtime.mode
          }
        });
      } else if (status === 'stopped') {
        this.log({
          level: 'info',
          category: 'forwarding',
          message: '포트 포워딩이 중지되었습니다.',
          metadata: { ruleId }
        });
      } else {
        this.log({
          level: 'error',
          category: 'forwarding',
          message: '포트 포워딩 실행 중 오류가 발생했습니다.',
          metadata: { ruleId, message: runtime.message ?? null }
        });
      }
      return;
    }

    if (event.sessionId) {
      const existing = this.tabs.get(event.sessionId);
      if (existing) {
        if (event.type === 'closed') {
          this.tabs.delete(event.sessionId);
          this.lastResizeBySession.delete(event.sessionId);
          this.log({
            level: 'info',
            category: 'ssh',
            message: 'SSH 세션이 종료되었습니다.',
            metadata: { sessionId: event.sessionId, message: event.payload.message ?? null }
          });
          this.broadcastTerminalEvent(event);
          return;
        }
        // 코어 이벤트를 탭 상태로 축약해 renderer가 바로 표시할 수 있게 한다.
        const nextStatus =
          event.type === 'connected'
            ? 'connected'
            : event.type === 'error'
              ? 'error'
              : existing.status;
        this.tabs.set(event.sessionId, {
          ...existing,
          status: nextStatus,
          errorMessage: event.type === 'error' ? String(event.payload.message ?? 'SSH error') : existing.errorMessage,
          lastEventAt: new Date().toISOString()
        });
        if (event.type === 'connected') {
          this.log({
            level: 'info',
            category: 'ssh',
            message: 'SSH 세션이 연결되었습니다.',
            metadata: { sessionId: event.sessionId, hostId: existing.hostId, title: existing.title }
          });
        }
        if (event.type === 'error') {
          this.log({
            level: 'error',
            category: 'ssh',
            message: 'SSH 세션 오류가 발생했습니다.',
            metadata: { sessionId: event.sessionId, message: event.payload.message ?? null }
          });
        }
      }
      this.broadcastTerminalEvent(event);
      return;
    }

    if (event.type === 'status' || event.type === 'error') {
      this.broadcastTerminalEvent(event);
    }
  }

  private requestResponse<TPayload extends Record<string, unknown>>(
    request: CoreRequest<unknown>,
    expectedTypes: CoreEventType[]
  ): Promise<TPayload> {
    if (!this.process) {
      throw new Error('SSH core process is not running');
    }

    return new Promise<TPayload>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(request.id);
        reject(new Error(`Timed out waiting for SSH core response: ${request.type}`));
      }, 8000);

      this.pendingResponses.set(request.id, {
        resolve: (payload) => resolve(payload as TPayload),
        reject,
        expectedTypes: new Set(expectedTypes),
        timeout
      });

      this.sendControl(request);
    });
  }

  private resolvePendingResponse(event: CoreEvent<Record<string, unknown>>): void {
    if (!event.requestId) {
      return;
    }
    const pending = this.pendingResponses.get(event.requestId);
      if (!pending) {
      return;
    }

    if (event.type === 'error' || event.type === 'sftpError' || event.type === 'portForwardError') {
      clearTimeout(pending.timeout);
      this.pendingResponses.delete(event.requestId);
      pending.reject(new Error(String(event.payload.message ?? 'SSH core error')));
      return;
    }

    if (!pending.expectedTypes.has(event.type)) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingResponses.delete(event.requestId);
    pending.resolve(event.payload);
  }

  private rejectAllPending(message: string): void {
    for (const [requestId, pending] of this.pendingResponses.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
      this.pendingResponses.delete(requestId);
    }
  }

  private describeTransferEndpoint(endpoint: TransferStartInput['source']): string {
    if (endpoint.kind === 'local') {
      return 'Local';
    }
    return this.sftpEndpoints.get(endpoint.endpointId)?.title ?? 'Remote';
  }

  private clearRuntimeState(): void {
    this.tabs.clear();
    this.sftpEndpoints.clear();
    this.transferJobs.clear();
    this.portForwardDefinitions.clear();
    this.portForwardRuntimes.clear();
    this.lastResizeBySession.clear();
  }

  private buildForwardRuntime(ruleId: string, payload: Record<string, unknown>, status: PortForwardRuntimeRecord['status']): PortForwardRuntimeRecord {
    const fallback = this.portForwardDefinitions.get(ruleId);
    return {
      ruleId,
      hostId: fallback?.hostId ?? '',
      mode:
        payload.mode === 'remote' || payload.mode === 'dynamic'
          ? (payload.mode as PortForwardMode)
          : fallback?.mode ?? 'local',
      bindAddress: String(payload.bindAddress ?? fallback?.bindAddress ?? '127.0.0.1'),
      bindPort: Number(payload.bindPort ?? fallback?.bindPort ?? 0),
      status,
      message: payload.message ? String(payload.message) : undefined,
      updatedAt: new Date().toISOString(),
      startedAt: status === 'running' ? new Date().toISOString() : this.portForwardRuntimes.get(ruleId)?.startedAt
    };
  }

  private sendControl<TPayload>(request: CoreRequest<TPayload>): void {
    if (!this.process) {
      throw new Error('SSH core process is not running');
    }
    this.process.stdin.write(encodeControlFrame(request));
  }

  private sendStream(metadata: CoreStreamFrame, payload: Uint8Array): void {
    if (!this.process) {
      throw new Error('SSH core process is not running');
    }
    this.process.stdin.write(encodeStreamFrame(metadata, payload));
  }

  private broadcastTerminalEvent(event: CoreEvent<Record<string, unknown>>): void {
    // 여러 윈도우가 열려 있어도 동일한 코어 상태를 함께 받도록 fan-out 한다.
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.ssh.event, event);
      }
    }
  }

  private broadcastTransferEvent(event: TransferJobEvent): void {
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.sftp.transferEvent, event);
      }
    }
  }

  private broadcastPortForwardEvent(event: PortForwardRuntimeEvent): void {
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.portForwards.event, event);
      }
    }
  }

  private broadcastStream(metadata: CoreStreamFrame, payload: Uint8Array): void {
    if (metadata.type !== 'data') {
      return;
    }
    // 터미널 데이터는 별도 채널로 보내 renderer store를 거치지 않고 xterm으로 직결한다.
    for (const window of this.windows) {
      if (!window.isDestroyed()) {
        window.webContents.send(ipcChannels.ssh.data, {
          sessionId: metadata.sessionId,
          chunk: new Uint8Array(payload)
        });
      }
    }
  }

  private log(entry: ActivityLogInput): void {
    this.appendLog?.(entry);
  }
}
