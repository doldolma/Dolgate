import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  isAwsEc2HostRecord,
  isAwsSsmPortForwardDraft,
  isAwsSsmPortForwardRuleRecord,
  isContainerPortForwardDraft,
  isContainerPortForwardRuleRecord,
  isSshHostRecord,
  isSshPortForwardDraft,
  isSshPortForwardRuleRecord,
  isWarpgateSshHostRecord
} from '@shared';
import type {
  HostContainerDetails,
  HostContainerSummary,
  HostRecord,
  PortForwardDraft,
  PortForwardRuleRecord,
  PortForwardRuntimeRecord
} from '@shared';
import type {
  PendingContainersInteractiveAuth,
  PendingHostKeyPrompt,
  PendingPortForwardInteractiveAuth
} from '../store/createAppStore';
import { DialogBackdrop } from './DialogBackdrop';
import { KnownHostPromptDialog } from './KnownHostPromptDialog';

type ForwardTab = 'ssh' | 'aws-ssm' | 'container';

interface PortForwardingPanelProps {
  hosts: HostRecord[];
  rules: PortForwardRuleRecord[];
  runtimes: PortForwardRuntimeRecord[];
  interactiveAuth: PendingPortForwardInteractiveAuth | null;
  discoveryInteractiveAuth: PendingContainersInteractiveAuth | null;
  onSave: (ruleId: string | null, draft: PortForwardDraft) => Promise<void>;
  onRemove: (ruleId: string) => Promise<void>;
  onStart: (ruleId: string) => Promise<void>;
  onStop: (ruleId: string) => Promise<void>;
  onRespondInteractiveAuth: (challengeId: string, responses: string[]) => Promise<void>;
  onReopenInteractiveAuthUrl: () => Promise<void>;
  onClearInteractiveAuth: () => void;
}

interface InteractiveAuthFormProps {
  auth: PendingContainersInteractiveAuth | PendingPortForwardInteractiveAuth;
  title: string;
  onRespond: (challengeId: string, responses: string[]) => Promise<void>;
  onReopenUrl: () => Promise<void>;
  onClear: () => void;
}

type InteractivePromptResponses = Record<string, string>;

type DiscoveryContainerStatusTone = 'running' | 'starting' | 'paused' | 'stopped';

interface DiscoveryContainerStatusPresentation {
  label: string;
  tone: DiscoveryContainerStatusTone;
}

function isWarpgateCompletionPrompt(label: string, instruction: string): boolean {
  return /press enter when done|press enter to continue|once authorized|after authoriz|after logging in|after completing authentication|hit enter|return to continue/i.test(
    `${label}\n${instruction}`
  );
}

function isWarpgateCodePrompt(label: string, instruction: string): boolean {
  return /code|verification|security|token|device/i.test(label) || (/code/i.test(instruction) && !/press enter/i.test(label));
}

function resolveWarpgateResponses(
  auth: PendingContainersInteractiveAuth | PendingPortForwardInteractiveAuth
): string[] | null {
  const responses: string[] = [];
  for (const prompt of auth.prompts) {
    if (auth.authCode && isWarpgateCodePrompt(prompt.label, auth.instruction)) {
      responses.push(auth.authCode);
      continue;
    }
    if (isWarpgateCompletionPrompt(prompt.label, auth.instruction)) {
      responses.push('');
      continue;
    }
    return null;
  }
  return responses;
}

function buildContainersEndpointId(hostId: string): string {
  return `containers:${hostId}`;
}

function shortenContainerImage(image: string): string {
  const trimmed = image.trim();
  if (!trimmed) {
    return '-';
  }
  const segments = trimmed.split('/').filter(Boolean);
  return segments.at(-1) ?? trimmed;
}

function getDiscoveryContainerStatusPresentation(status: string): DiscoveryContainerStatusPresentation {
  const normalized = status.trim().toLowerCase();
  if (normalized.startsWith('up')) {
    return {
      label: 'Running',
      tone: 'running'
    };
  }
  if (normalized.includes('restarting')) {
    return {
      label: 'Restarting',
      tone: 'starting'
    };
  }
  if (normalized.includes('paused')) {
    return {
      label: 'Paused',
      tone: 'paused'
    };
  }
  return {
    label: 'Stopped',
    tone: 'stopped'
  };
}

function getContainerHostKindLabel(host: HostRecord): string {
  if (isAwsEc2HostRecord(host)) {
    return 'AWS';
  }
  if (isWarpgateSshHostRecord(host)) {
    return 'Warpgate';
  }
  return 'SSH';
}

function getContainerHostSecondaryLabel(host: HostRecord): string {
  if (isAwsEc2HostRecord(host)) {
    return `${host.awsProfileName} / ${host.awsRegion} / ${host.awsInstanceId}`;
  }
  if (isWarpgateSshHostRecord(host)) {
    return `${host.warpgateUsername}:${host.warpgateTargetName}`;
  }
  return host.hostname;
}

function emptySshDraft(hostId?: string): PortForwardDraft {
  return {
    transport: 'ssh',
    label: '',
    hostId: hostId ?? '',
    mode: 'local',
    bindAddress: '127.0.0.1',
    bindPort: 9000,
    targetHost: '127.0.0.1',
    targetPort: 80
  };
}

function emptyAwsDraft(hostId?: string): PortForwardDraft {
  return {
    transport: 'aws-ssm',
    label: '',
    hostId: hostId ?? '',
    bindAddress: '127.0.0.1',
    bindPort: 9000,
    targetKind: 'instance-port',
    targetPort: 80,
    remoteHost: ''
  };
}

function emptyContainerDraft(hostId?: string): PortForwardDraft {
  return {
    transport: 'container',
    label: '',
    hostId: hostId ?? '',
    bindAddress: '127.0.0.1',
    bindPort: 0,
    containerId: '',
    containerName: '',
    containerRuntime: 'docker',
    networkName: '',
    targetPort: 0
  };
}

function toDraft(rule: PortForwardRuleRecord): PortForwardDraft {
  if (isAwsSsmPortForwardRuleRecord(rule)) {
    return {
      transport: 'aws-ssm',
      label: rule.label,
      hostId: rule.hostId,
      bindAddress: rule.bindAddress,
      bindPort: rule.bindPort,
      targetKind: rule.targetKind,
      targetPort: rule.targetPort,
      remoteHost: rule.remoteHost ?? ''
    };
  }
  if (isContainerPortForwardRuleRecord(rule)) {
    return {
      transport: 'container',
      label: rule.label,
      hostId: rule.hostId,
      bindAddress: '127.0.0.1',
      bindPort: rule.bindPort,
      containerId: rule.containerId,
      containerName: rule.containerName,
      containerRuntime: rule.containerRuntime,
      networkName: rule.networkName,
      targetPort: rule.targetPort
    };
  }

  return {
    transport: 'ssh',
    label: rule.label,
    hostId: rule.hostId,
    mode: rule.mode,
    bindAddress: rule.bindAddress,
    bindPort: rule.bindPort,
    targetHost: rule.targetHost ?? '',
    targetPort: rule.targetPort ?? undefined
  };
}

function statusLabel(runtime?: PortForwardRuntimeRecord) {
  switch (runtime?.status) {
    case 'starting':
      return 'Starting';
    case 'running':
      return 'Running';
    case 'error':
      return 'Error';
    default:
      return 'Stopped';
  }
}

function runtimeMethodLabel(runtime?: PortForwardRuntimeRecord) {
  if (!runtime?.method) {
    return null;
  }
  if (runtime.method === 'ssh-session-proxy') {
    return 'SSH Fallback';
  }
  if (runtime.method === 'ssm-remote-host') {
    return 'SSM Remote Host';
  }
  return 'SSH Native';
}

function tabTitle(tab: ForwardTab) {
  if (tab === 'ssh') {
    return 'SSH Forwarding';
  }
  if (tab === 'aws-ssm') {
    return 'AWS SSM';
  }
  return 'Container Tunneling';
}

function createButtonLabel(tab: ForwardTab) {
  if (tab === 'ssh') {
    return 'New SSH Forward';
  }
  if (tab === 'aws-ssm') {
    return 'New AWS SSM Forward';
  }
  return 'New Container Tunnel';
}

function emptyStateTitle(tab: ForwardTab) {
  if (tab === 'ssh') {
    return '아직 저장한 SSH 포워딩 규칙이 없습니다.';
  }
  if (tab === 'aws-ssm') {
    return '아직 저장한 AWS SSM 포워딩 규칙이 없습니다.';
  }
  return '아직 저장한 컨테이너 터널 규칙이 없습니다.';
}

function emptyStateDescription(tab: ForwardTab) {
  if (tab === 'ssh') {
    return 'New SSH Forward를 눌러 첫 번째 SSH 포워딩 규칙을 만들어 보세요.';
  }
  if (tab === 'aws-ssm') {
    return 'New AWS SSM Forward를 눌러 첫 번째 AWS SSM 포워딩 규칙을 만들어 보세요.';
  }
  return 'New Container Tunnel을 눌러 첫 번째 컨테이너 터널 규칙을 만들어 보세요.';
}

export function filterPortForwardRules(rules: PortForwardRuleRecord[], tab: ForwardTab): PortForwardRuleRecord[] {
  return rules.filter((rule) => {
    if (tab === 'ssh') {
      return isSshPortForwardRuleRecord(rule);
    }
    if (tab === 'aws-ssm') {
      return isAwsSsmPortForwardRuleRecord(rule);
    }
    return isContainerPortForwardRuleRecord(rule);
  });
}

export function getAvailablePortForwardHosts(hosts: HostRecord[], tab: ForwardTab): HostRecord[] {
  if (tab === 'ssh') {
    return hosts.filter(isSshHostRecord);
  }
  if (tab === 'aws-ssm') {
    return hosts.filter(isAwsEc2HostRecord);
  }
  return hosts.filter((host) => isSshHostRecord(host) || isAwsEc2HostRecord(host) || isWarpgateSshHostRecord(host));
}

export function shouldShowAwsRemoteHostField(draft: PortForwardDraft): boolean {
  return isAwsSsmPortForwardDraft(draft) && draft.targetKind === 'remote-host';
}

function InteractiveAuthCard({ auth, title, onRespond, onReopenUrl, onClear }: InteractiveAuthFormProps) {
  const [responses, setResponses] = useState<InteractivePromptResponses>({});
  const warpgateResponses = useMemo(
    () => (auth.provider === 'warpgate' ? resolveWarpgateResponses(auth) : null),
    [auth]
  );

  useEffect(() => {
    setResponses({});
  }, [auth.challengeId]);

  return (
    <div className="empty-callout">
      <strong>{title}</strong>
      {auth.provider === 'warpgate' ? (
        <>
          <p>브라우저에서 Warpgate 로그인과 승인을 마치면 앱이 자동으로 다음 단계를 진행합니다.</p>
          {auth.authCode ? (
            <p className="terminal-interactive-auth__code">
              인증 코드 <code>{auth.authCode}</code>는 앱이 자동으로 처리합니다.
            </p>
          ) : null}
          <div className="operations-card__actions" style={{ marginTop: 12 }}>
            {auth.approvalUrl ? (
              <button type="button" className="secondary-button" onClick={() => void onReopenUrl()}>
                브라우저 다시 열기
              </button>
            ) : null}
            <button type="button" className="ghost-button" onClick={onClear}>
              닫기
            </button>
          </div>
          {warpgateResponses ? null : (
            <div className="empty-callout" style={{ marginTop: 12 }}>
              <strong>추가 입력이 필요합니다.</strong>
              <p>이 Warpgate challenge는 자동 입력 형식과 다릅니다. 아래 prompt에 직접 응답해 주세요.</p>
            </div>
          )}
          <pre className="terminal-interactive-auth__raw" style={{ marginTop: 12 }}>
            {auth.instruction || '추가 인증이 필요합니다.'}
          </pre>
        </>
      ) : (
        <p>{auth.instruction || '추가 인증이 필요합니다.'}</p>
      )}
      {auth.provider !== 'warpgate' && auth.approvalUrl ? (
        <div className="operations-card__actions" style={{ marginTop: 12 }}>
          <button type="button" className="secondary-button" onClick={() => void onReopenUrl()}>
            브라우저 다시 열기
          </button>
          <button type="button" className="ghost-button" onClick={onClear}>
            닫기
          </button>
        </div>
      ) : null}
      {(auth.provider !== 'warpgate' || !warpgateResponses) && auth.prompts.length > 0 ? (
        <div className="form-grid" style={{ marginTop: 16 }}>
          {auth.prompts.map((prompt, index) => (
            <label key={`${auth.challengeId}-${index}`} className="form-field">
              <span>{prompt.label || `Prompt ${index + 1}`}</span>
              <input
                type={prompt.echo ? 'text' : 'password'}
                value={responses[index] ?? ''}
                onChange={(event) =>
                  setResponses((current) => ({
                    ...current,
                    [index]: event.target.value
                  }))
                }
              />
            </label>
          ))}
          <div className="modal-card__footer" style={{ padding: 0, marginTop: 12 }}>
            <button type="button" className="secondary-button" onClick={onClear}>
              취소
            </button>
            <button
              type="button"
              className="primary-button"
              onClick={() =>
                void onRespond(
                  auth.challengeId,
                  auth.prompts.map((_prompt, index) => responses[index] ?? '')
                )
              }
            >
              계속
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

interface PickerFieldProps {
  label: string;
  placeholder: string;
  isOpen: boolean;
  disabled?: boolean;
  onToggle: () => void;
  children: ReactNode;
  selectedContent?: ReactNode;
}

function PickerField({
  label,
  placeholder,
  isOpen,
  disabled = false,
  onToggle,
  children,
  selectedContent,
}: PickerFieldProps) {
  return (
    <div className="form-field port-forward-picker">
      <span>{label}</span>
      <button
        type="button"
        className={`port-forward-picker__trigger ${isOpen ? 'is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={label}
        onClick={onToggle}
        disabled={disabled}
      >
        {selectedContent ? (
          selectedContent
        ) : (
          <div className="port-forward-picker__placeholder">{placeholder}</div>
        )}
        <span className="port-forward-picker__chevron" aria-hidden="true">
          ▾
        </span>
      </button>
      {isOpen ? (
        <div className="port-forward-picker__popover" role="listbox" aria-label={`${label} options`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function resolveDefaultNetworkName(details: HostContainerDetails, currentValue: string): string {
  const availableNetworks = details.networks;
  if (availableNetworks.length === 0) {
    return '';
  }
  if (availableNetworks.some((network) => network.name === currentValue)) {
    return currentValue;
  }
  return availableNetworks[0]?.name ?? '';
}

function resolveDefaultTargetPort(details: HostContainerDetails, currentValue: number): number {
  const eligiblePorts = details.ports.filter((port) => port.protocol === 'tcp' && port.containerPort > 0);
  if (eligiblePorts.length === 0) {
    return 0;
  }
  if (eligiblePorts.some((port) => port.containerPort === currentValue)) {
    return currentValue;
  }
  return eligiblePorts[0]?.containerPort ?? 0;
}

export function PortForwardingPanel({
  hosts,
  rules,
  runtimes,
  interactiveAuth,
  discoveryInteractiveAuth,
  onSave,
  onRemove,
  onStart,
  onStop,
  onRespondInteractiveAuth,
  onReopenInteractiveAuthUrl,
  onClearInteractiveAuth
}: PortForwardingPanelProps) {
  const sshHosts = useMemo(() => getAvailablePortForwardHosts(hosts, 'ssh').filter(isSshHostRecord), [hosts]);
  const awsHosts = useMemo(() => getAvailablePortForwardHosts(hosts, 'aws-ssm').filter(isAwsEc2HostRecord), [hosts]);
  const containerHosts = useMemo(() => getAvailablePortForwardHosts(hosts, 'container'), [hosts]);
  const [activeTab, setActiveTab] = useState<ForwardTab>('ssh');
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PortForwardDraft>(() => emptySshDraft(sshHosts[0]?.id));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [discoveryProgressMessage, setDiscoveryProgressMessage] = useState<string | null>(null);
  const [discoveryContainers, setDiscoveryContainers] = useState<HostContainerSummary[]>([]);
  const [discoveryDetails, setDiscoveryDetails] = useState<HostContainerDetails | null>(null);
  const [discoveryDetailsLoading, setDiscoveryDetailsLoading] = useState(false);
  const [isHostPickerOpen, setIsHostPickerOpen] = useState(false);
  const [isContainerPickerOpen, setIsContainerPickerOpen] = useState(false);
  const [knownHostPrompt, setKnownHostPrompt] = useState<PendingHostKeyPrompt | null>(null);
  const discoveryHostIdRef = useRef<string | null>(null);
  const discoveryListRequestRef = useRef(0);
  const discoveryDetailsRequestRef = useRef(0);
  const hostPickerRef = useRef<HTMLDivElement | null>(null);
  const containerPickerRef = useRef<HTMLDivElement | null>(null);
  const runtimeMap = useMemo(() => new Map(runtimes.map((runtime) => [runtime.ruleId, runtime])), [runtimes]);
  const visibleRules = useMemo(() => filterPortForwardRules(rules, activeTab), [activeTab, rules]);
  const containerDraft = isContainerPortForwardDraft(draft) ? draft : null;
  const shouldShowDiscoveryProgress = Boolean(discoveryProgressMessage) && (discoveryLoading || discoveryDetailsLoading);
  const selectedContainerSummary =
    containerDraft && containerDraft.containerId
      ? discoveryContainers.find((container) => container.id === containerDraft.containerId) ?? null
      : null;
  const availableNetworks = useMemo(() => discoveryDetails?.networks ?? [], [discoveryDetails]);
  const eligibleNetworks = useMemo(
    () => discoveryDetails?.networks.filter((network) => Boolean(network.ipAddress?.trim())) ?? [],
    [discoveryDetails]
  );
  const eligiblePorts = useMemo(
    () => discoveryDetails?.ports.filter((port) => port.protocol === 'tcp' && port.containerPort > 0) ?? [],
    [discoveryDetails]
  );

  async function releaseDiscoveryHost(hostId: string | null) {
    if (!hostId) {
      return;
    }
    await window.dolssh.containers.release(hostId).catch(() => undefined);
  }

  function resetDiscoveryState() {
    setDiscoveryLoading(false);
    setDiscoveryError(null);
    setDiscoveryProgressMessage(null);
    setDiscoveryContainers([]);
    setDiscoveryDetails(null);
    setDiscoveryDetailsLoading(false);
    setIsContainerPickerOpen(false);
    setKnownHostPrompt(null);
  }

  function openCreate(tab: ForwardTab = activeTab) {
    setActiveTab(tab);
    setEditingRuleId(null);
    setIsHostPickerOpen(false);
    setIsContainerPickerOpen(false);
    setDraft(
      tab === 'ssh'
        ? emptySshDraft(sshHosts[0]?.id)
        : tab === 'aws-ssm'
          ? emptyAwsDraft(awsHosts[0]?.id)
          : emptyContainerDraft()
    );
    setIsSubmitting(false);
    setError(null);
    resetDiscoveryState();
    setIsModalOpen(true);
  }

  function openEdit(rule: PortForwardRuleRecord) {
    setEditingRuleId(rule.id);
    setActiveTab(rule.transport);
    setIsHostPickerOpen(false);
    setIsContainerPickerOpen(false);
    setDraft(toDraft(rule));
    setIsSubmitting(false);
    setError(null);
    resetDiscoveryState();
    setIsModalOpen(true);
  }

  async function closeModal() {
    if (isSubmitting) {
      return;
    }
    setIsModalOpen(false);
    setIsHostPickerOpen(false);
    setIsContainerPickerOpen(false);
    setKnownHostPrompt(null);
    await releaseDiscoveryHost(discoveryHostIdRef.current);
    discoveryHostIdRef.current = null;
  }

  async function probeDiscoveryHost(hostId: string): Promise<boolean> {
    const probe = await window.dolssh.knownHosts.probeHost({
      hostId,
      endpointId: buildContainersEndpointId(hostId)
    });
    if (probe.status === 'trusted') {
      return true;
    }
    setKnownHostPrompt({
      probe,
      action: {
        kind: 'containers',
        hostId,
      }
    });
    return false;
  }

  async function loadContainerList(hostId: string) {
    const requestId = ++discoveryListRequestRef.current;
    if (!hostId) {
      if (requestId === discoveryListRequestRef.current) {
        resetDiscoveryState();
      }
      return;
    }
    setDiscoveryLoading(true);
    setDiscoveryError(null);
    setDiscoveryProgressMessage(null);
    setDiscoveryContainers([]);
    setDiscoveryDetails(null);
    try {
      const trusted = await probeDiscoveryHost(hostId);
      if (!trusted) {
        return;
      }
      const result = await window.dolssh.containers.list(hostId);
      if (
        requestId !== discoveryListRequestRef.current ||
        discoveryHostIdRef.current !== hostId
      ) {
        return;
      }
      setDiscoveryContainers(result.containers);
      setDiscoveryError(result.unsupportedReason ?? null);
      setDiscoveryProgressMessage(null);
    } catch (cause) {
      if (
        requestId !== discoveryListRequestRef.current ||
        discoveryHostIdRef.current !== hostId
      ) {
        return;
      }
      setDiscoveryError(cause instanceof Error ? cause.message : '컨테이너 목록을 불러오지 못했습니다.');
      setDiscoveryContainers([]);
    } finally {
      if (requestId === discoveryListRequestRef.current) {
        setDiscoveryLoading(false);
      }
    }
  }

  async function loadContainerDetails(hostId: string, containerId: string) {
    const requestId = ++discoveryDetailsRequestRef.current;
    if (!hostId || !containerId) {
      setDiscoveryDetails(null);
      return;
    }
    setDiscoveryDetailsLoading(true);
    setDiscoveryError(null);
    try {
      const details = await window.dolssh.containers.inspect(hostId, containerId);
      if (
        requestId !== discoveryDetailsRequestRef.current ||
        discoveryHostIdRef.current !== hostId
      ) {
        return;
      }
      setDiscoveryDetails(details);
      setDraft((current) => {
        if (!isContainerPortForwardDraft(current) || current.hostId !== hostId || current.containerId !== containerId) {
          return current;
        }
        return {
          ...current,
          containerName: details.name,
          containerRuntime: details.runtime,
          networkName: resolveDefaultNetworkName(details, current.networkName),
          targetPort: resolveDefaultTargetPort(details, current.targetPort)
        };
      });
    } catch (cause) {
      if (
        requestId !== discoveryDetailsRequestRef.current ||
        discoveryHostIdRef.current !== hostId
      ) {
        return;
      }
      setDiscoveryDetails(null);
      setDiscoveryError(cause instanceof Error ? cause.message : '컨테이너 상세 정보를 불러오지 못했습니다.');
    } finally {
      if (requestId === discoveryDetailsRequestRef.current) {
        setDiscoveryDetailsLoading(false);
      }
    }
  }

  async function handleAcceptKnownHost(mode: 'trust' | 'replace') {
    if (!knownHostPrompt) {
      return;
    }
    const input = {
      hostId: knownHostPrompt.probe.hostId,
      hostLabel: knownHostPrompt.probe.hostLabel,
      host: knownHostPrompt.probe.host,
      port: knownHostPrompt.probe.port,
      algorithm: knownHostPrompt.probe.algorithm,
      publicKeyBase64: knownHostPrompt.probe.publicKeyBase64,
      fingerprintSha256: knownHostPrompt.probe.fingerprintSha256
    };
    if (mode === 'replace') {
      await window.dolssh.knownHosts.replace(input);
    } else {
      await window.dolssh.knownHosts.trust(input);
    }
    const hostId = knownHostPrompt.probe.hostId;
    setKnownHostPrompt(null);
    await loadContainerList(hostId);
  }

  async function handleSubmit() {
    if (isSubmitting) {
      return;
    }

    if (!draft.label.trim()) {
      setError('이름을 입력해 주세요.');
      return;
    }
    if (!draft.hostId) {
      setError('호스트를 선택해 주세요.');
      return;
    }

    if (isContainerPortForwardDraft(draft)) {
      if (draft.bindPort < 0) {
        setError('로컬 포트를 올바르게 입력해 주세요.');
        return;
      }
      if (!draft.containerId) {
        setError('컨테이너를 선택해 주세요.');
        return;
      }
      if (!draft.networkName) {
        setError('컨테이너 네트워크를 선택해 주세요.');
        return;
      }
      if (!draft.targetPort || draft.targetPort <= 0) {
        setError('대상 포트를 선택해 주세요.');
        return;
      }
      setIsSubmitting(true);
      setError(null);
      try {
        await onSave(editingRuleId, {
          ...draft,
          bindAddress: '127.0.0.1'
        });
        await closeModal();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '포워딩 규칙을 저장하지 못했습니다.');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (draft.bindPort <= 0) {
      setError('로컬 포트를 올바르게 입력해 주세요.');
      return;
    }

    if (isAwsSsmPortForwardDraft(draft)) {
      if (!draft.targetPort || draft.targetPort <= 0) {
        setError('대상 포트를 올바르게 입력해 주세요.');
        return;
      }
      if (draft.targetKind === 'remote-host' && !draft.remoteHost?.trim()) {
        setError('원격 호스트를 입력해 주세요.');
        return;
      }

      setIsSubmitting(true);
      setError(null);
      try {
        await onSave(editingRuleId, {
          ...draft,
          bindAddress: '127.0.0.1',
          remoteHost: draft.targetKind === 'remote-host' ? draft.remoteHost?.trim() ?? null : null
        });
        await closeModal();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '포워딩 규칙을 저장하지 못했습니다.');
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (draft.mode !== 'dynamic' && (!draft.targetHost?.trim() || !draft.targetPort || draft.targetPort <= 0)) {
      setError('대상 호스트와 포트를 올바르게 입력해 주세요.');
      return;
    }

    setIsSubmitting(true);
    setError(null);
    try {
      await onSave(editingRuleId, {
        ...draft,
        targetHost: draft.mode === 'dynamic' ? null : draft.targetHost?.trim() ?? null,
        targetPort: draft.mode === 'dynamic' ? null : draft.targetPort ?? null
      });
      await closeModal();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '포워딩 규칙을 저장하지 못했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  }

  useEffect(() => {
    const unsubscribe = window.dolssh.containers.onConnectionProgress((event) => {
      if (!containerDraft || !isModalOpen) {
        return;
      }
      if (event.hostId !== containerDraft.hostId) {
        return;
      }
      setDiscoveryProgressMessage(event.message);
    });
    return unsubscribe;
  }, [containerDraft, isModalOpen]);

  useEffect(() => {
    if (!isModalOpen) {
      setIsHostPickerOpen(false);
      setIsContainerPickerOpen(false);
    }
  }, [isModalOpen]);

  useEffect(() => {
    if (!isModalOpen || (!isHostPickerOpen && !isContainerPickerOpen)) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (hostPickerRef.current?.contains(target) || containerPickerRef.current?.contains(target)) {
        return;
      }
      setIsHostPickerOpen(false);
      setIsContainerPickerOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      setIsHostPickerOpen(false);
      setIsContainerPickerOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isContainerPickerOpen, isHostPickerOpen, isModalOpen]);

  useEffect(() => {
    if (!isModalOpen || !containerDraft) {
      const previousHostId = discoveryHostIdRef.current;
      discoveryListRequestRef.current += 1;
      discoveryDetailsRequestRef.current += 1;
      discoveryHostIdRef.current = null;
      void releaseDiscoveryHost(previousHostId);
      resetDiscoveryState();
      return;
    }
    const previousHostId = discoveryHostIdRef.current;
    if (previousHostId && previousHostId !== containerDraft.hostId) {
      discoveryListRequestRef.current += 1;
      discoveryDetailsRequestRef.current += 1;
      void releaseDiscoveryHost(previousHostId);
    }
    discoveryHostIdRef.current = containerDraft.hostId || null;
    void loadContainerList(containerDraft.hostId);
  }, [containerDraft?.hostId, isModalOpen]);

  useEffect(() => {
    if (!isModalOpen || !containerDraft?.hostId || !containerDraft.containerId) {
      setDiscoveryDetails(null);
      return;
    }
    void loadContainerDetails(containerDraft.hostId, containerDraft.containerId);
  }, [containerDraft?.hostId, containerDraft?.containerId, isModalOpen]);

  const discoveryHost = containerDraft ? containerHosts.find((host) => host.id === containerDraft.hostId) ?? null : null;
  const isAutoLocalPort = containerDraft?.bindPort === 0;

  return (
    <div className="operations-panel">
      <div className="operations-panel__header">
        <div>
          <div className="section-kicker">Forwarding</div>
          <h2>Port Forwarding</h2>
          <p>SSH 포워딩, AWS SSM 포워딩, 컨테이너 터널 규칙을 저장하고 필요할 때만 실행합니다.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => openCreate(activeTab)}>
          {createButtonLabel(activeTab)}
        </button>
      </div>

      {interactiveAuth ? (
        <InteractiveAuthCard
          auth={interactiveAuth}
          title="Container tunnel 승인을 기다리는 중입니다."
          onRespond={onRespondInteractiveAuth}
          onReopenUrl={onReopenInteractiveAuthUrl}
          onClear={onClearInteractiveAuth}
        />
      ) : null}

      {!isModalOpen && discoveryInteractiveAuth ? (
        <InteractiveAuthCard
          auth={discoveryInteractiveAuth}
          title="컨테이너 런타임 연결 승인을 기다리는 중입니다."
          onRespond={onRespondInteractiveAuth}
          onReopenUrl={onReopenInteractiveAuthUrl}
          onClear={onClearInteractiveAuth}
        />
      ) : null}

      <div className="operations-tabs" role="tablist" aria-label="Port forwarding transport">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'ssh'}
          className={`operations-tab ${activeTab === 'ssh' ? 'active' : ''}`}
          onClick={() => setActiveTab('ssh')}
        >
          SSH Forwarding
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'aws-ssm'}
          className={`operations-tab ${activeTab === 'aws-ssm' ? 'active' : ''}`}
          onClick={() => setActiveTab('aws-ssm')}
        >
          AWS SSM
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'container'}
          className={`operations-tab ${activeTab === 'container' ? 'active' : ''}`}
          onClick={() => setActiveTab('container')}
        >
          Container
        </button>
      </div>

      <div className="operations-list">
        {visibleRules.length === 0 ? (
          <div className="empty-callout">
            <strong>{emptyStateTitle(activeTab)}</strong>
            <p>{emptyStateDescription(activeTab)}</p>
          </div>
        ) : (
          visibleRules.map((rule) => {
            const runtime = runtimeMap.get(rule.id);
            const isRunning = runtime?.status === 'running' || runtime?.status === 'starting';

            if (isAwsSsmPortForwardRuleRecord(rule)) {
              const host = awsHosts.find((item) => item.id === rule.hostId);
              return (
                <article key={rule.id} className="operations-card">
                  <div className="operations-card__main">
                    <div className="operations-card__title-row">
                      <strong>{rule.label}</strong>
                      <span className={`status-pill status-pill--${runtime?.status ?? 'stopped'}`}>{statusLabel(runtime)}</span>
                    </div>
                    <div className="operations-card__meta">
                      <span>AWS SSM</span>
                      {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
                      <span>
                        {host ? `${host.label} (${host.awsProfileName} / ${host.awsRegion} / ${host.awsInstanceId})` : 'Unknown AWS host'}
                      </span>
                      <span>{(runtime?.bindAddress ?? rule.bindAddress) || '127.0.0.1'}:{runtime?.bindPort ?? rule.bindPort}</span>
                      <span>{rule.targetKind === 'remote-host' ? `${rule.remoteHost}:${rule.targetPort}` : `instance:${rule.targetPort}`}</span>
                    </div>
                    {runtime?.message ? <p className="operations-card__message">{runtime.message}</p> : null}
                  </div>
                  <div className="operations-card__actions">
                    <button type="button" className="secondary-button" onClick={() => void (isRunning ? onStop(rule.id) : onStart(rule.id))}>
                      {isRunning ? 'Stop' : 'Start'}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => openEdit(rule)}>
                      Edit
                    </button>
                    <button type="button" className="secondary-button danger" onClick={() => void onRemove(rule.id)}>
                      Delete
                    </button>
                  </div>
                </article>
              );
            }

            if (isContainerPortForwardRuleRecord(rule)) {
              const host = containerHosts.find((item) => item.id === rule.hostId);
              return (
                <article key={rule.id} className="operations-card">
                  <div className="operations-card__main">
                    <div className="operations-card__title-row">
                      <strong>{rule.label}</strong>
                      <span className={`status-pill status-pill--${runtime?.status ?? 'stopped'}`}>{statusLabel(runtime)}</span>
                    </div>
                    <div className="operations-card__meta">
                      <span>Container</span>
                      {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
                      <span>{host ? host.label : 'Unknown host'}</span>
                      <span>{rule.containerName} ({rule.containerRuntime})</span>
                      <span>{runtime?.bindAddress ?? '127.0.0.1'}:{(runtime?.bindPort ?? rule.bindPort) || 'auto'}</span>
                      <span>{rule.networkName}:{rule.targetPort}</span>
                    </div>
                    {runtime?.message ? <p className="operations-card__message">{runtime.message}</p> : null}
                  </div>
                  <div className="operations-card__actions">
                    <button type="button" className="secondary-button" onClick={() => void (isRunning ? onStop(rule.id) : onStart(rule.id))}>
                      {isRunning ? 'Stop' : 'Start'}
                    </button>
                    <button type="button" className="secondary-button" onClick={() => openEdit(rule)}>
                      Edit
                    </button>
                    <button type="button" className="secondary-button danger" onClick={() => void onRemove(rule.id)}>
                      Delete
                    </button>
                  </div>
                </article>
              );
            }

            const host = sshHosts.find((item) => item.id === rule.hostId);
            return (
              <article key={rule.id} className="operations-card">
                <div className="operations-card__main">
                  <div className="operations-card__title-row">
                    <strong>{rule.label}</strong>
                    <span className={`status-pill status-pill--${runtime?.status ?? 'stopped'}`}>{statusLabel(runtime)}</span>
                  </div>
                  <div className="operations-card__meta">
                    <span>{rule.mode.toUpperCase()}</span>
                    {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
                    <span>{host ? `${host.label} (${host.hostname})` : 'Unknown SSH host'}</span>
                    <span>{rule.bindAddress}:{runtime?.bindPort ?? rule.bindPort}</span>
                    <span>{rule.mode === 'dynamic' ? 'SOCKS5' : `${rule.targetHost}:${rule.targetPort}`}</span>
                  </div>
                  {runtime?.message ? <p className="operations-card__message">{runtime.message}</p> : null}
                </div>
                <div className="operations-card__actions">
                  <button type="button" className="secondary-button" onClick={() => void (isRunning ? onStop(rule.id) : onStart(rule.id))}>
                    {isRunning ? 'Stop' : 'Start'}
                  </button>
                  <button type="button" className="secondary-button" onClick={() => openEdit(rule)}>
                    Edit
                  </button>
                  <button type="button" className="secondary-button danger" onClick={() => void onRemove(rule.id)}>
                    Delete
                  </button>
                </div>
              </article>
            );
          })
        )}
      </div>

      {isModalOpen ? (
        <DialogBackdrop onDismiss={() => void closeModal()} dismissDisabled={isSubmitting}>
          <div
            className={`modal-card port-forwarding-modal ${isContainerPortForwardDraft(draft) ? 'port-forwarding-modal--container' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="port-forward-title"
          >
            <div className="modal-card__header">
              <div>
                <div className="section-kicker">Forwarding</div>
                <h3 id="port-forward-title">{editingRuleId ? `Edit ${tabTitle(activeTab)}` : createButtonLabel(activeTab)}</h3>
              </div>
              <button
                type="button"
                className="icon-button"
                onClick={() => void closeModal()}
                disabled={isSubmitting}
                aria-label="Close port forwarding dialog"
              >
                &times;
              </button>
            </div>

            <div className="modal-card__body form-grid">
              <label className="form-field">
                <span>Label</span>
                <input value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} disabled={isSubmitting} />
              </label>

              {isContainerPortForwardDraft(draft) ? (
                <div ref={hostPickerRef}>
                  <PickerField
                    label="Host"
                    placeholder="Select host"
                    isOpen={isHostPickerOpen}
                    disabled={isSubmitting || discoveryLoading || discoveryDetailsLoading}
                    onToggle={() => {
                      if (isSubmitting || discoveryLoading || discoveryDetailsLoading) {
                        return;
                      }
                      setIsContainerPickerOpen(false);
                      setIsHostPickerOpen((current) => !current);
                    }}
                    selectedContent={
                      discoveryHost ? (
                        <div className="port-forward-picker__selection">
                          <div className="port-forward-picker__selection-main">
                            <strong>{discoveryHost.label}</strong>
                            <span>{getContainerHostSecondaryLabel(discoveryHost)}</span>
                          </div>
                          <span className="port-forward-picker__kind-badge">{getContainerHostKindLabel(discoveryHost)}</span>
                        </div>
                      ) : undefined
                    }
                  >
                    {containerHosts.map((host) => (
                      <button
                        key={host.id}
                        type="button"
                        role="option"
                        aria-selected={draft.hostId === host.id}
                        className={`port-forward-picker__option-card ${draft.hostId === host.id ? 'is-selected' : ''}`}
                        onClick={() => {
                          setIsHostPickerOpen(false);
                          setDraft((current) => {
                            if (!isContainerPortForwardDraft(current)) {
                              return current;
                            }
                            return {
                              ...current,
                              hostId: host.id,
                              containerId: '',
                              containerName: '',
                              networkName: '',
                              targetPort: 0,
                            };
                          });
                        }}
                      >
                        <div className="port-forward-picker__option-main">
                          <strong>{host.label}</strong>
                          <span>{getContainerHostSecondaryLabel(host)}</span>
                        </div>
                        <span className="port-forward-picker__kind-badge">{getContainerHostKindLabel(host)}</span>
                      </button>
                    ))}
                  </PickerField>
                </div>
              ) : (
                <label className="form-field">
                  <span>{isAwsSsmPortForwardDraft(draft) ? 'AWS Host' : 'Host'}</span>
                  <select
                    value={draft.hostId}
                    onChange={(event) => {
                      const nextHostId = event.target.value;
                      setDraft((current) => ({ ...current, hostId: nextHostId }));
                    }}
                    disabled={isSubmitting}
                  >
                    <option value="">Select host</option>
                    {(isAwsSsmPortForwardDraft(draft) ? awsHosts : sshHosts).map((host) => (
                      <option key={host.id} value={host.id}>
                        {isAwsEc2HostRecord(host)
                          ? `${host.label} (${host.awsProfileName} / ${host.awsRegion} / ${host.awsInstanceId})`
                          : `${host.label} (${host.hostname})`}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {isContainerPortForwardDraft(draft) ? (
                <>
                  {shouldShowDiscoveryProgress ? (
                    <div className="empty-callout">
                      <strong>Container discovery</strong>
                      <p>{discoveryProgressMessage}</p>
                    </div>
                  ) : null}

                  {discoveryInteractiveAuth && discoveryHost?.id === discoveryInteractiveAuth.hostId ? (
                    <InteractiveAuthCard
                      auth={discoveryInteractiveAuth}
                      title="컨테이너 조회를 위한 승인을 기다리는 중입니다."
                      onRespond={onRespondInteractiveAuth}
                      onReopenUrl={onReopenInteractiveAuthUrl}
                      onClear={onClearInteractiveAuth}
                    />
                  ) : null}

                  <div ref={containerPickerRef}>
                    <PickerField
                      label="Container"
                      placeholder="Select container"
                      isOpen={isContainerPickerOpen}
                      disabled={isSubmitting || discoveryLoading || !draft.hostId}
                      onToggle={() => {
                        if (isSubmitting || discoveryLoading || !draft.hostId) {
                          return;
                        }
                        setIsHostPickerOpen(false);
                        setIsContainerPickerOpen((current) => !current);
                      }}
                      selectedContent={
                        selectedContainerSummary ? (
                          <div className="port-forward-picker__selection">
                            <div className="port-forward-picker__selection-main">
                              <strong>{selectedContainerSummary.name}</strong>
                              <span>{shortenContainerImage(selectedContainerSummary.image)}</span>
                            </div>
                            <span
                              className={`status-pill port-forward-picker__status-badge status-pill--${getDiscoveryContainerStatusPresentation(selectedContainerSummary.status).tone}`}
                            >
                              {getDiscoveryContainerStatusPresentation(selectedContainerSummary.status).label}
                            </span>
                          </div>
                        ) : undefined
                      }
                    >
                      {discoveryContainers.map((container) => {
                        const statusPresentation = getDiscoveryContainerStatusPresentation(container.status);
                        return (
                          <button
                            key={container.id}
                            type="button"
                            role="option"
                            aria-selected={draft.containerId === container.id}
                            className={`port-forward-picker__option-card ${draft.containerId === container.id ? 'is-selected' : ''}`}
                            onClick={() => {
                              setIsContainerPickerOpen(false);
                              setDraft((current) =>
                                isContainerPortForwardDraft(current)
                                  ? {
                                      ...current,
                                      containerId: container.id,
                                      networkName: '',
                                      targetPort: 0,
                                    }
                                  : current
                              );
                            }}
                          >
                            <div className="port-forward-picker__option-main">
                              <strong>{container.name}</strong>
                              <span>{shortenContainerImage(container.image)}</span>
                            </div>
                            <span className={`status-pill port-forward-picker__status-badge status-pill--${statusPresentation.tone}`}>
                              {statusPresentation.label}
                            </span>
                          </button>
                        );
                      })}
                    </PickerField>
                  </div>

                  {availableNetworks.length > 1 ? (
                    <label className="form-field">
                      <span>Network</span>
                      <div className="port-forward-native-select">
                        <select
                          className="port-forward-native-select__control"
                          value={draft.networkName}
                          onChange={(event) =>
                            setDraft((current) =>
                              isContainerPortForwardDraft(current)
                                ? {
                                    ...current,
                                    networkName: event.target.value,
                                  }
                                : current
                            )
                          }
                          disabled={isSubmitting || discoveryDetailsLoading || !draft.containerId}
                        >
                          <option value="">Select network</option>
                          {availableNetworks.map((network) => (
                            <option key={network.name} value={network.name}>
                              {network.ipAddress ? `${network.name} (${network.ipAddress})` : `${network.name} (IP 확인 대기)`}
                            </option>
                          ))}
                        </select>
                        <span className="port-forward-native-select__chevron" aria-hidden="true">
                          ▾
                        </span>
                      </div>
                    </label>
                  ) : null}

                  <label className="form-field">
                    <span>Container port</span>
                    <div className="port-forward-native-select">
                      <select
                        className="port-forward-native-select__control"
                        value={draft.targetPort || ''}
                        onChange={(event) =>
                          setDraft((current) =>
                            isContainerPortForwardDraft(current)
                              ? {
                                  ...current,
                                  targetPort: Number(event.target.value),
                                }
                              : current
                          )
                        }
                        disabled={isSubmitting || discoveryDetailsLoading || !draft.containerId}
                      >
                        <option value="">Select TCP port</option>
                        {eligiblePorts.map((port) => (
                          <option key={`${port.protocol}-${port.containerPort}`} value={port.containerPort}>
                            {port.containerPort}/tcp
                          </option>
                        ))}
                      </select>
                      <span className="port-forward-native-select__chevron" aria-hidden="true">
                        ▾
                      </span>
                    </div>
                  </label>

                  <label className="form-field">
                    <span>Local port</span>
                    <div className="port-forward-local-port">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isAutoLocalPort}
                        aria-label="Auto (random)"
                        className={`port-forward-toggle ${isAutoLocalPort ? 'is-active' : ''}`}
                        onClick={() =>
                          setDraft((current) =>
                            isContainerPortForwardDraft(current)
                              ? {
                                  ...current,
                                  bindPort: isAutoLocalPort ? 9000 : 0,
                                }
                              : current
                          )
                        }
                        disabled={isSubmitting}
                      >
                        <span className="port-forward-toggle__track" aria-hidden="true">
                          <span className="port-forward-toggle__thumb" />
                        </span>
                        <span className="port-forward-toggle__content">
                          <strong>Auto (random)</strong>
                          <span>사용 가능한 로컬 포트를 자동으로 할당합니다.</span>
                        </span>
                      </button>
                      <input
                        type="number"
                        className="port-forward-local-port__input"
                        value={isAutoLocalPort ? '' : draft.bindPort}
                        onChange={(event) =>
                          setDraft((current) =>
                            isContainerPortForwardDraft(current)
                              ? {
                                  ...current,
                                  bindPort: Number(event.target.value),
                                }
                              : current
                          )
                        }
                        disabled={isSubmitting || isAutoLocalPort}
                        placeholder={isAutoLocalPort ? '자동 할당' : '9000'}
                      />
                    </div>
                  </label>

                  {discoveryError ? <div className="form-error">{discoveryError}</div> : null}
                  {discoveryDetailsLoading ? <div className="empty-callout"><p>컨테이너 상세 정보를 불러오는 중입니다.</p></div> : null}
                  {discoveryDetails && eligiblePorts.length === 0 ? (
                    <div className="empty-callout">
                      <strong>선택 가능한 TCP 포트가 없습니다.</strong>
                      <p>이 컨테이너에는 포워딩에 사용할 TCP 포트가 감지되지 않았습니다.</p>
                    </div>
                  ) : null}
                  {discoveryDetails && availableNetworks.length === 0 ? (
                    <div className="empty-callout">
                      <strong>사용 가능한 네트워크 IP가 없습니다.</strong>
                      <p>이 컨테이너는 연결할 네트워크 정보가 없어 터널 규칙을 저장할 수 없습니다.</p>
                    </div>
                  ) : null}
                  {discoveryDetails && availableNetworks.length > 0 && eligibleNetworks.length === 0 ? (
                    <div className="empty-callout">
                      <strong>현재는 네트워크 IP가 보이지 않습니다.</strong>
                      <p>종료된 컨테이너일 수 있습니다. 규칙은 저장할 수 있고, 시작할 때 현재 IP를 다시 확인합니다.</p>
                    </div>
                  ) : null}
                </>
              ) : isSshPortForwardDraft(draft) ? (
                <>
                  <label className="form-field">
                    <span>Mode</span>
                    <select
                      value={draft.mode}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          mode: event.target.value as typeof draft.mode
                        }))
                      }
                      disabled={isSubmitting}
                    >
                      <option value="local">Local</option>
                      <option value="remote">Remote</option>
                      <option value="dynamic">Dynamic</option>
                    </select>
                  </label>

                  <label className="form-field">
                    <span>Bind address</span>
                    <input
                      value={draft.bindAddress}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          bindAddress: event.target.value
                        })
                      }
                      disabled={isSubmitting}
                    />
                  </label>
                </>
              ) : (
                <>
                  <label className="form-field">
                    <span>Target kind</span>
                    <select
                      value={draft.targetKind}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          targetKind: event.target.value as typeof draft.targetKind
                        })
                      }
                      disabled={isSubmitting}
                    >
                      <option value="instance-port">Instance port</option>
                      <option value="remote-host">Remote host</option>
                    </select>
                  </label>

                  <label className="form-field">
                    <span>Local address</span>
                    <input value="127.0.0.1" disabled readOnly />
                  </label>
                </>
              )}

              {!isContainerPortForwardDraft(draft) ? (
                <label className="form-field">
                  <span>{isAwsSsmPortForwardDraft(draft) ? 'Local port' : 'Bind port'}</span>
                  <input
                    type="number"
                    value={draft.bindPort}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        bindPort: Number(event.target.value)
                      })
                    }
                    disabled={isSubmitting}
                  />
                </label>
              ) : null}

              {isSshPortForwardDraft(draft) && draft.mode !== 'dynamic' ? (
                <>
                  <label className="form-field">
                    <span>Target host</span>
                    <input
                      value={draft.targetHost ?? ''}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          targetHost: event.target.value
                        })
                      }
                      disabled={isSubmitting}
                    />
                  </label>

                  <label className="form-field">
                    <span>Target port</span>
                    <input
                      type="number"
                      value={draft.targetPort ?? ''}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          targetPort: Number(event.target.value)
                        })
                      }
                      disabled={isSubmitting}
                    />
                  </label>
                </>
              ) : null}

              {isAwsSsmPortForwardDraft(draft) ? (
                <>
                  {shouldShowAwsRemoteHostField(draft) ? (
                    <label className="form-field">
                      <span>Remote host</span>
                      <input
                        value={draft.remoteHost ?? ''}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            remoteHost: event.target.value
                          })
                        }
                        disabled={isSubmitting}
                      />
                    </label>
                  ) : null}

                  <label className="form-field">
                    <span>Target port</span>
                    <input
                      type="number"
                      value={draft.targetPort}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          targetPort: Number(event.target.value)
                        })
                      }
                      disabled={isSubmitting}
                    />
                  </label>
                </>
              ) : null}

              {error ? <div className="form-error">{error}</div> : null}
            </div>

            <div className="modal-card__footer">
              <button type="button" className="secondary-button" onClick={() => void closeModal()} disabled={isSubmitting}>
                취소
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleSubmit()}
                disabled={
                  isSubmitting ||
                  (isContainerPortForwardDraft(draft) &&
                    (!draft.containerId || !draft.networkName || !draft.targetPort || availableNetworks.length === 0 || eligiblePorts.length === 0))
                }
              >
                저장
              </button>
            </div>
          </div>
        </DialogBackdrop>
      ) : null}

      {knownHostPrompt ? (
        <KnownHostPromptDialog
          pending={knownHostPrompt}
          onAccept={handleAcceptKnownHost}
          onCancel={() => setKnownHostPrompt(null)}
        />
      ) : null}
    </div>
  );
}
