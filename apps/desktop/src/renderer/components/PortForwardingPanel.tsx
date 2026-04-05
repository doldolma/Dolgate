import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  isAwsEc2HostRecord,
  isAwsEcsHostRecord,
  isDnsOverrideEligiblePortForwardRule,
  isLinkedDnsOverrideDraft,
  isLinkedDnsOverrideRecord,
  isEcsTaskPortForwardDraft,
  isEcsTaskPortForwardRuleRecord,
  isAwsSsmPortForwardDraft,
  isAwsSsmPortForwardRuleRecord,
  isContainerPortForwardDraft,
  isContainerPortForwardRuleRecord,
  isLoopbackBindAddress,
  isSshHostRecord,
  isSshPortForwardDraft,
  isSshPortForwardRuleRecord,
  isStaticDnsOverrideDraft,
  isStaticDnsOverrideRecord,
  isWarpgateSshHostRecord
} from '@shared';
import type {
  AwsEcsTaskTunnelContainerSummary,
  AwsEcsTaskTunnelServiceSummary,
  DnsOverrideDraft,
  DnsOverrideResolvedRecord,
  HostContainerDetails,
  HostContainerSummary,
  HostRecord,
  PortForwardDraft,
  PortForwardRuleRecord,
  PortForwardRuntimeRecord
} from '@shared';
import type {
  HostContainersTabState,
  PendingContainersInteractiveAuth,
  PendingHostKeyPrompt,
  PendingPortForwardInteractiveAuth
} from '../store/createAppStore';
import { normalizeErrorMessage } from '../store/utils';
import { usePortForwardingPanelController } from '../controllers/usePortForwardingPanelController';
import {
  Badge,
  Button,
  Card,
  CardActions,
  CardMain,
  CardMessage,
  CardMeta,
  CardTitleRow,
  EmptyState,
  IconButton,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  SectionLabel,
  StatusBadge,
  TabButton,
  Tabs,
} from '../ui';
import { DialogBackdrop } from './DialogBackdrop';
import { KnownHostPromptDialog } from './KnownHostPromptDialog';

type ForwardTab = 'ssh' | 'aws-ssm' | 'ecs-task' | 'container' | 'dns';

let lastSelectedForwardTab: ForwardTab = 'ssh';

export function resetPortForwardingPanelUiStateForTests() {
  lastSelectedForwardTab = 'ssh';
}

interface PortForwardingPanelProps {
  hosts: HostRecord[];
  containerTabs: HostContainersTabState[];
  rules: PortForwardRuleRecord[];
  dnsOverrides: DnsOverrideResolvedRecord[];
  runtimes: PortForwardRuntimeRecord[];
  interactiveAuth: PendingPortForwardInteractiveAuth | null;
  discoveryInteractiveAuth: PendingContainersInteractiveAuth | null;
  onSave: (ruleId: string | null, draft: PortForwardDraft) => Promise<void>;
  onSaveDnsOverride: (overrideId: string | null, draft: DnsOverrideDraft) => Promise<void>;
  onSetStaticDnsOverrideActive: (overrideId: string, active: boolean) => Promise<void>;
  onRemove: (ruleId: string) => Promise<void>;
  onRemoveDnsOverride: (overrideId: string) => Promise<void>;
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

interface EcsEphemeralRuntimeCard {
  runtime: PortForwardRuntimeRecord;
  host: HostRecord | null;
  serviceName: string;
  containerName: string;
  targetPort: string;
}

interface ContainerEphemeralRuntimeCard {
  runtime: PortForwardRuntimeRecord;
  host: HostRecord | null;
  containerName: string;
  networkName: string;
  targetPort: string;
}

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
  if (isAwsEcsHostRecord(host)) {
    return `${host.awsProfileName} / ${host.awsRegion} / ${host.awsEcsClusterName}`;
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

function emptyEcsTaskDraft(hostId?: string): PortForwardDraft {
  return {
    transport: 'ecs-task',
    label: '',
    hostId: hostId ?? '',
    bindAddress: '127.0.0.1',
    bindPort: 0,
    serviceName: '',
    containerName: '',
    targetPort: 0,
  };
}

function emptyDnsDraft(ruleId?: string): DnsOverrideDraft {
  return {
    type: 'linked',
    hostname: '',
    portForwardRuleId: ruleId ?? ''
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
  if (isEcsTaskPortForwardRuleRecord(rule)) {
    return {
      transport: 'ecs-task',
      label: rule.label,
      hostId: rule.hostId,
      bindAddress: '127.0.0.1',
      bindPort: rule.bindPort,
      serviceName: rule.serviceName,
      containerName: rule.containerName,
      targetPort: rule.targetPort,
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

function getRuntimeStatusTone(
  status?: string | null,
): ComponentProps<typeof StatusBadge>['tone'] {
  switch (status) {
    case 'running':
      return 'running';
    case 'starting':
      return 'starting';
    case 'paused':
      return 'paused';
    case 'error':
      return 'error';
    default:
      return 'stopped';
  }
}

function tabTitle(tab: ForwardTab) {
  if (tab === 'ssh') {
    return 'SSH Forwarding';
  }
  if (tab === 'aws-ssm') {
    return 'AWS EC2';
  }
  if (tab === 'ecs-task') {
    return 'ECS Task';
  }
  if (tab === 'dns') {
    return 'DNS Override';
  }
  return 'Container Tunneling';
}

function createButtonLabel(tab: ForwardTab) {
  if (tab === 'ssh') {
    return 'New SSH Forward';
  }
  if (tab === 'aws-ssm') {
    return 'New AWS EC2 Forward';
  }
  if (tab === 'ecs-task') {
    return 'New ECS Task Tunnel';
  }
  if (tab === 'dns') {
    return 'New DNS Override';
  }
  return 'New Container Tunnel';
}

function emptyStateTitle(tab: ForwardTab) {
  if (tab === 'ssh') {
    return '아직 저장한 SSH 포워딩 규칙이 없습니다.';
  }
  if (tab === 'aws-ssm') {
    return '아직 저장한 AWS EC2 포워딩 규칙이 없습니다.';
  }
  if (tab === 'ecs-task') {
    return '아직 저장한 ECS Task 터널 규칙이 없습니다.';
  }
  if (tab === 'dns') {
    return '아직 저장한 DNS Override가 없습니다.';
  }
  return '아직 저장한 컨테이너 터널 규칙이 없습니다.';
}

function emptyStateDescription(tab: ForwardTab) {
  if (tab === 'ssh') {
    return 'New SSH Forward를 눌러 첫 번째 SSH 포워딩 규칙을 만들어 보세요.';
  }
  if (tab === 'aws-ssm') {
    return 'New AWS EC2 Forward를 눌러 첫 번째 AWS EC2 포워딩 규칙을 만들어 보세요.';
  }
  if (tab === 'ecs-task') {
    return 'New ECS Task Tunnel을 눌러 첫 번째 ECS task 터널 규칙을 만들어 보세요.';
  }
  if (tab === 'dns') {
    return 'New DNS Override를 눌러 hosts 기반 도메인 override를 추가해 보세요.';
  }
  return 'New Container Tunnel을 눌러 첫 번째 컨테이너 터널 규칙을 만들어 보세요.';
}

export function filterPortForwardRules(rules: PortForwardRuleRecord[], tab: Exclude<ForwardTab, 'dns'>): PortForwardRuleRecord[] {
  return rules.filter((rule) => {
    if (tab === 'ssh') {
      return isSshPortForwardRuleRecord(rule);
    }
    if (tab === 'aws-ssm') {
      return isAwsSsmPortForwardRuleRecord(rule);
    }
    if (tab === 'ecs-task') {
      return isEcsTaskPortForwardRuleRecord(rule);
    }
    return isContainerPortForwardRuleRecord(rule);
  });
}

export function getAvailablePortForwardHosts(hosts: HostRecord[], tab: Exclude<ForwardTab, 'dns'>): HostRecord[] {
  if (tab === 'ssh') {
    return hosts.filter(isSshHostRecord);
  }
  if (tab === 'aws-ssm') {
    return hosts.filter(isAwsEc2HostRecord);
  }
  if (tab === 'ecs-task') {
    return hosts.filter(isAwsEcsHostRecord);
  }
  return hosts.filter((host) => isSshHostRecord(host) || isAwsEc2HostRecord(host) || isWarpgateSshHostRecord(host));
}

export function getDnsOverrideEligibleRules(rules: PortForwardRuleRecord[]): PortForwardRuleRecord[] {
  return rules.filter(isDnsOverrideEligiblePortForwardRule);
}

export function shouldShowAwsRemoteHostField(draft: PortForwardDraft): boolean {
  return isAwsSsmPortForwardDraft(draft) && draft.targetKind === 'remote-host';
}

function isDnsHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized || normalized.includes('*') || normalized.includes(' ') || normalized.endsWith('.')) {
    return false;
  }
  const labels = normalized.split('.');
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
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
    <NoticeCard title={title} className="mt-4">
      {auth.provider === 'warpgate' ? (
        <>
          <p>브라우저에서 Warpgate 로그인과 승인을 마치면 앱이 자동으로 다음 단계를 진행합니다.</p>
          {auth.authCode ? (
            <p className="terminal-interactive-auth__code">
              인증 코드 <code>{auth.authCode}</code>는 앱이 자동으로 처리합니다.
            </p>
          ) : null}
          <div className="operations-card__actions mt-3 flex flex-wrap gap-3">
            {auth.approvalUrl ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => void onReopenUrl()}>
                브라우저 다시 열기
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={onClear}>
              닫기
            </Button>
          </div>
          {warpgateResponses ? null : (
            <NoticeCard title="추가 입력이 필요합니다." className="mt-3">
              <p>이 Warpgate challenge는 자동 입력 형식과 다릅니다. 아래 prompt에 직접 응답해 주세요.</p>
            </NoticeCard>
          )}
          <pre className="terminal-interactive-auth__raw" style={{ marginTop: 12 }}>
            {auth.instruction || '추가 인증이 필요합니다.'}
          </pre>
        </>
      ) : (
        <p>{auth.instruction || '추가 인증이 필요합니다.'}</p>
      )}
      {auth.provider !== 'warpgate' && auth.approvalUrl ? (
        <div className="operations-card__actions mt-3 flex flex-wrap gap-3">
          <Button type="button" variant="secondary" size="sm" onClick={() => void onReopenUrl()}>
            브라우저 다시 열기
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onClear}>
            닫기
          </Button>
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
          <div className="mt-3 flex items-center justify-end gap-3">
            <Button type="button" variant="secondary" onClick={onClear}>
              취소
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() =>
                void onRespond(
                  auth.challengeId,
                  auth.prompts.map((_prompt, index) => responses[index] ?? '')
                )
              }
            >
              계속
            </Button>
          </div>
        </div>
      ) : null}
    </NoticeCard>
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
  containerTabs,
  rules,
  dnsOverrides,
  runtimes,
  interactiveAuth,
  discoveryInteractiveAuth,
  onSave,
  onSaveDnsOverride,
  onSetStaticDnsOverrideActive,
  onRemove,
  onRemoveDnsOverride,
  onStart,
  onStop,
  onRespondInteractiveAuth,
  onReopenInteractiveAuthUrl,
  onClearInteractiveAuth
}: PortForwardingPanelProps) {
  const {
    inspectHostContainer,
    listEcsTaskTunnelServices,
    listHostContainers,
    loadEcsTaskTunnelService,
    onContainersConnectionProgress,
    probeKnownHost,
    releaseContainerHost,
    replaceKnownHost,
    trustKnownHost,
  } = usePortForwardingPanelController();
  const sshHosts = useMemo(() => getAvailablePortForwardHosts(hosts, 'ssh').filter(isSshHostRecord), [hosts]);
  const awsHosts = useMemo(() => getAvailablePortForwardHosts(hosts, 'aws-ssm').filter(isAwsEc2HostRecord), [hosts]);
  const ecsHosts = useMemo(() => getAvailablePortForwardHosts(hosts, 'ecs-task').filter(isAwsEcsHostRecord), [hosts]);
  const containerHosts = useMemo(
    () => getAvailablePortForwardHosts(hosts, 'container').filter((host) => !isAwsEcsHostRecord(host)),
    [hosts],
  );
  const [activeTab, setActiveTab] = useState<ForwardTab>(lastSelectedForwardTab);
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [editingDnsOverrideId, setEditingDnsOverrideId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PortForwardDraft>(() => emptySshDraft(sshHosts[0]?.id));
  const [dnsDraft, setDnsDraft] = useState<DnsOverrideDraft>(() => emptyDnsDraft());
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dnsToggleError, setDnsToggleError] = useState<string | null>(null);
  const [pendingDnsToggleId, setPendingDnsToggleId] = useState<string | null>(null);
  const [ecsServicesLoading, setEcsServicesLoading] = useState(false);
  const [ecsServicesError, setEcsServicesError] = useState<string | null>(null);
  const [ecsServices, setEcsServices] = useState<AwsEcsTaskTunnelServiceSummary[]>([]);
  const [ecsServiceDetailsLoading, setEcsServiceDetailsLoading] = useState(false);
  const [ecsServiceDetails, setEcsServiceDetails] = useState<{
    serviceName: string;
    containers: AwsEcsTaskTunnelContainerSummary[];
  } | null>(null);
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
  const eligibleRules = useMemo(() => getDnsOverrideEligibleRules(rules), [rules]);
  const ruleMap = useMemo(
    () => new Map(rules.map((rule) => [rule.id, rule])),
    [rules],
  );
  const runtimeMap = useMemo(() => new Map(runtimes.map((runtime) => [runtime.ruleId, runtime])), [runtimes]);
  const visibleRules = useMemo(
    () => (activeTab === 'dns' ? [] : filterPortForwardRules(rules, activeTab)),
    [activeTab, rules]
  );
  const visibleEcsEphemeralRuntimes = useMemo(() => {
    if (activeTab !== 'ecs-task') {
      return [];
    }
    const next = new Map<string, EcsEphemeralRuntimeCard>();
    for (const tab of containerTabs) {
      if (tab.kind !== 'ecs-cluster') {
        continue;
      }
      for (const tunnelState of Object.values(tab.ecsTunnelStatesByServiceName)) {
        const persistedRuntime = tunnelState.runtime;
        if (!persistedRuntime?.ruleId.startsWith('ecs-service-tunnel:')) {
          continue;
        }
        const runtime = runtimeMap.get(persistedRuntime.ruleId) ?? persistedRuntime;
        if (runtime.status === 'stopped' || ruleMap.has(runtime.ruleId) || next.has(runtime.ruleId)) {
          continue;
        }
        next.set(runtime.ruleId, {
          runtime,
          host: hosts.find((host) => host.id === runtime.hostId) ?? null,
          serviceName: tunnelState.serviceName,
          containerName: tunnelState.containerName ?? '-',
          targetPort: tunnelState.targetPort,
        });
      }
    }
    return Array.from(next.values()).sort((left, right) =>
      `${left.serviceName}:${left.containerName}`.localeCompare(
        `${right.serviceName}:${right.containerName}`,
      ),
    );
  }, [activeTab, containerTabs, hosts, ruleMap, runtimeMap]);
  const visibleContainerEphemeralRuntimes = useMemo(() => {
    if (activeTab !== 'container') {
      return [];
    }
    const next = new Map<string, ContainerEphemeralRuntimeCard>();
    for (const tab of containerTabs) {
      if (tab.kind !== 'host-containers') {
        continue;
      }
      for (const tunnelState of Object.values(tab.containerTunnelStatesByContainerId)) {
        const persistedRuntime = tunnelState.runtime;
        if (!persistedRuntime?.ruleId.startsWith('container-service-tunnel:')) {
          continue;
        }
        const runtime = runtimeMap.get(persistedRuntime.ruleId) ?? persistedRuntime;
        if (runtime.status === 'stopped' || ruleMap.has(runtime.ruleId) || next.has(runtime.ruleId)) {
          continue;
        }
        next.set(runtime.ruleId, {
          runtime,
          host: hosts.find((host) => host.id === runtime.hostId) ?? null,
          containerName: tunnelState.containerName || tunnelState.containerId,
          networkName: tunnelState.networkName,
          targetPort: tunnelState.targetPort,
        });
      }
    }
    return Array.from(next.values()).sort((left, right) =>
      `${left.containerName}:${left.networkName}`.localeCompare(
        `${right.containerName}:${right.networkName}`,
      ),
    );
  }, [activeTab, containerTabs, hosts, ruleMap, runtimeMap]);
  const hasVisibleEntries =
    activeTab === 'dns'
      ? dnsOverrides.length > 0
      : visibleRules.length > 0 ||
        visibleEcsEphemeralRuntimes.length > 0 ||
        visibleContainerEphemeralRuntimes.length > 0;
  const containerDraft = isContainerPortForwardDraft(draft) ? draft : null;
  const ecsTaskDraft = isEcsTaskPortForwardDraft(draft) ? draft : null;
  const shouldShowDiscoveryProgress = Boolean(discoveryProgressMessage) && (discoveryLoading || discoveryDetailsLoading);
  const selectedContainerSummary =
    containerDraft && containerDraft.containerId
      ? discoveryContainers.find((container) => container.id === containerDraft.containerId) ?? null
      : null;
  const availableNetworks = useMemo(() => discoveryDetails?.networks ?? [], [discoveryDetails]);

  useEffect(() => {
    lastSelectedForwardTab = activeTab;
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== 'dns') {
      setDnsToggleError(null);
      setPendingDnsToggleId(null);
    }
  }, [activeTab]);
  const eligibleNetworks = useMemo(
    () => discoveryDetails?.networks.filter((network) => Boolean(network.ipAddress?.trim())) ?? [],
    [discoveryDetails]
  );
  const eligiblePorts = useMemo(
    () => discoveryDetails?.ports.filter((port) => port.protocol === 'tcp' && port.containerPort > 0) ?? [],
    [discoveryDetails]
  );
  const selectedEcsHost = ecsTaskDraft ? ecsHosts.find((host) => host.id === ecsTaskDraft.hostId) ?? null : null;
  const ecsContainerOptions = useMemo(
    () => ecsServiceDetails?.containers ?? [],
    [ecsServiceDetails],
  );
  const ecsSelectedContainer = useMemo(
    () => ecsContainerOptions.find((container) => container.containerName === ecsTaskDraft?.containerName) ?? null,
    [ecsContainerOptions, ecsTaskDraft?.containerName],
  );
  const ecsPortOptions = useMemo(
    () => ecsSelectedContainer?.ports ?? [],
    [ecsSelectedContainer],
  );

  function renderRuleCard(rule: PortForwardRuleRecord) {
    const runtime = runtimeMap.get(rule.id);
    const isRunning =
      runtime?.status === 'running' || runtime?.status === 'starting';

    if (isAwsSsmPortForwardRuleRecord(rule)) {
      const host = awsHosts.find((item) => item.id === rule.hostId);
      return (
        <Card key={rule.id} className="operations-card">
          <CardMain className="operations-card__main">
            <CardTitleRow className="operations-card__title-row">
              <strong>{rule.label}</strong>
              <StatusBadge tone={getRuntimeStatusTone(runtime?.status)}>
                {statusLabel(runtime)}
              </StatusBadge>
            </CardTitleRow>
            <CardMeta className="operations-card__meta">
              <span>AWS EC2</span>
              {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
              <span>
                {host ? `${host.label} (${host.awsProfileName} / ${host.awsRegion} / ${host.awsInstanceId})` : 'Unknown AWS host'}
              </span>
              <span>{(runtime?.bindAddress ?? rule.bindAddress) || '127.0.0.1'}:{runtime?.bindPort ?? rule.bindPort}</span>
              <span>{rule.targetKind === 'remote-host' ? `${rule.remoteHost}:${rule.targetPort}` : `instance:${rule.targetPort}`}</span>
            </CardMeta>
            {runtime?.message ? <CardMessage className="operations-card__message">{runtime.message}</CardMessage> : null}
          </CardMain>
          <CardActions className="operations-card__actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => void (isRunning ? onStop(rule.id) : onStart(rule.id))}>
              {isRunning ? 'Stop' : 'Start'}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => openEdit(rule)}>
              Edit
            </Button>
            <Button type="button" variant="danger" size="sm" onClick={() => void onRemove(rule.id)}>
              Delete
            </Button>
          </CardActions>
        </Card>
      );
    }

    if (isEcsTaskPortForwardRuleRecord(rule)) {
      const host = ecsHosts.find((item) => item.id === rule.hostId);
      return (
        <Card key={rule.id} className="operations-card">
          <CardMain className="operations-card__main">
            <CardTitleRow className="operations-card__title-row">
              <strong>{rule.label}</strong>
              <StatusBadge tone={getRuntimeStatusTone(runtime?.status)}>
                {statusLabel(runtime)}
              </StatusBadge>
            </CardTitleRow>
            <CardMeta className="operations-card__meta">
              <span>ECS Task</span>
              {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
              <span>
                {host
                  ? `${host.label} (${host.awsProfileName} / ${host.awsRegion} / ${host.awsEcsClusterName})`
                  : 'Unknown ECS host'}
              </span>
              <span>{rule.serviceName} / {rule.containerName}</span>
              <span>{runtime?.bindAddress ?? '127.0.0.1'}:{(runtime?.bindPort ?? rule.bindPort) || 'auto'}</span>
              <span>127.0.0.1:{rule.targetPort}</span>
            </CardMeta>
            {runtime?.message ? <CardMessage className="operations-card__message">{runtime.message}</CardMessage> : null}
          </CardMain>
          <CardActions className="operations-card__actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => void (isRunning ? onStop(rule.id) : onStart(rule.id))}>
              {isRunning ? 'Stop' : 'Start'}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => openEdit(rule)}>
              Edit
            </Button>
            <Button type="button" variant="danger" size="sm" onClick={() => void onRemove(rule.id)}>
              Delete
            </Button>
          </CardActions>
        </Card>
      );
    }

    if (isContainerPortForwardRuleRecord(rule)) {
      const host = containerHosts.find((item) => item.id === rule.hostId);
      return (
        <Card key={rule.id} className="operations-card">
          <CardMain className="operations-card__main">
            <CardTitleRow className="operations-card__title-row">
              <strong>{rule.label}</strong>
              <StatusBadge tone={getRuntimeStatusTone(runtime?.status)}>
                {statusLabel(runtime)}
              </StatusBadge>
            </CardTitleRow>
            <CardMeta className="operations-card__meta">
              <span>Container</span>
              {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
              <span>{host ? host.label : 'Unknown host'}</span>
              <span>{rule.containerName} ({rule.containerRuntime})</span>
              <span>{runtime?.bindAddress ?? '127.0.0.1'}:{(runtime?.bindPort ?? rule.bindPort) || 'auto'}</span>
              <span>{rule.networkName}:{rule.targetPort}</span>
            </CardMeta>
            {runtime?.message ? <CardMessage className="operations-card__message">{runtime.message}</CardMessage> : null}
          </CardMain>
          <CardActions className="operations-card__actions">
            <Button type="button" variant="secondary" size="sm" onClick={() => void (isRunning ? onStop(rule.id) : onStart(rule.id))}>
              {isRunning ? 'Stop' : 'Start'}
            </Button>
            <Button type="button" variant="secondary" size="sm" onClick={() => openEdit(rule)}>
              Edit
            </Button>
            <Button type="button" variant="danger" size="sm" onClick={() => void onRemove(rule.id)}>
              Delete
            </Button>
          </CardActions>
        </Card>
      );
    }

    const host = sshHosts.find((item) => item.id === rule.hostId);
    return (
      <Card key={rule.id} className="operations-card">
        <CardMain className="operations-card__main">
          <CardTitleRow className="operations-card__title-row">
            <strong>{rule.label}</strong>
            <StatusBadge tone={getRuntimeStatusTone(runtime?.status)}>
              {statusLabel(runtime)}
            </StatusBadge>
          </CardTitleRow>
          <CardMeta className="operations-card__meta">
            <span>{rule.mode.toUpperCase()}</span>
            {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
            <span>{host ? `${host.label} (${host.hostname})` : 'Unknown SSH host'}</span>
            <span>{rule.bindAddress}:{runtime?.bindPort ?? rule.bindPort}</span>
            <span>{rule.mode === 'dynamic' ? 'SOCKS5' : `${rule.targetHost}:${rule.targetPort}`}</span>
          </CardMeta>
          {runtime?.message ? <CardMessage className="operations-card__message">{runtime.message}</CardMessage> : null}
        </CardMain>
        <CardActions className="operations-card__actions">
          <Button type="button" variant="secondary" size="sm" onClick={() => void (isRunning ? onStop(rule.id) : onStart(rule.id))}>
            {isRunning ? 'Stop' : 'Start'}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => openEdit(rule)}>
            Edit
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={() => void onRemove(rule.id)}>
            Delete
          </Button>
        </CardActions>
      </Card>
    );
  }

  function renderEcsEphemeralRuntimeCard({
    runtime,
    host,
    serviceName,
    containerName,
    targetPort,
  }: EcsEphemeralRuntimeCard) {
    return (
      <Card key={runtime.ruleId} className="operations-card">
        <CardMain className="operations-card__main">
          <CardTitleRow className="operations-card__title-row">
            <strong>{serviceName}</strong>
            <Badge>Ephemeral</Badge>
            <StatusBadge tone={getRuntimeStatusTone(runtime.status)}>
              {statusLabel(runtime)}
            </StatusBadge>
          </CardTitleRow>
          <CardMeta className="operations-card__meta">
            <span>ECS Task</span>
            {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
            <span>
              {host && isAwsEcsHostRecord(host)
                ? `${host.label} (${host.awsProfileName} / ${host.awsRegion} / ${host.awsEcsClusterName})`
                : host?.label ?? 'Unknown ECS host'}
            </span>
            <span>{serviceName} / {containerName}</span>
            <span>{runtime.bindAddress}:{runtime.bindPort}</span>
            <span>127.0.0.1:{targetPort}</span>
          </CardMeta>
          {runtime.message ? <CardMessage className="operations-card__message">{runtime.message}</CardMessage> : null}
        </CardMain>
        <CardActions className="operations-card__actions">
          <Button type="button" variant="secondary" size="sm" onClick={() => void onStop(runtime.ruleId)}>
            Stop
          </Button>
        </CardActions>
      </Card>
    );
  }

  function renderContainerEphemeralRuntimeCard({
    runtime,
    host,
    containerName,
    networkName,
    targetPort,
  }: ContainerEphemeralRuntimeCard) {
    return (
      <Card key={runtime.ruleId} className="operations-card">
        <CardMain className="operations-card__main">
          <CardTitleRow className="operations-card__title-row">
            <strong>{containerName}</strong>
            <Badge>Ephemeral</Badge>
            <StatusBadge tone={getRuntimeStatusTone(runtime.status)}>
              {statusLabel(runtime)}
            </StatusBadge>
          </CardTitleRow>
          <CardMeta className="operations-card__meta">
            <span>Container</span>
            {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
            <span>{host?.label ?? 'Unknown host'}</span>
            <span>{containerName}</span>
            <span>{runtime.bindAddress}:{runtime.bindPort}</span>
            <span>{networkName}:{targetPort}</span>
          </CardMeta>
          {runtime.message ? <CardMessage className="operations-card__message">{runtime.message}</CardMessage> : null}
        </CardMain>
        <CardActions className="operations-card__actions">
          <Button type="button" variant="secondary" size="sm" onClick={() => void onStop(runtime.ruleId)}>
            Stop
          </Button>
        </CardActions>
      </Card>
    );
  }

  async function releaseDiscoveryHost(hostId: string | null) {
    if (!hostId) {
      return;
    }
    await releaseContainerHost(hostId).catch(() => undefined);
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

  function resetEcsDiscoveryState() {
    setEcsServicesLoading(false);
    setEcsServicesError(null);
    setEcsServices([]);
    setEcsServiceDetailsLoading(false);
    setEcsServiceDetails(null);
  }

  async function loadEcsServices(hostId: string) {
    if (!hostId) {
      resetEcsDiscoveryState();
      return;
    }
    setEcsServicesLoading(true);
    setEcsServicesError(null);
    setEcsServices([]);
    setEcsServiceDetails(null);
    try {
      const services = await listEcsTaskTunnelServices(hostId);
      setEcsServices(services);
    } catch (cause) {
      setEcsServicesError(cause instanceof Error ? cause.message : 'ECS 서비스 목록을 불러오지 못했습니다.');
    } finally {
      setEcsServicesLoading(false);
    }
  }

  async function loadEcsServiceDetails(hostId: string, serviceName: string) {
    if (!hostId || !serviceName) {
      setEcsServiceDetails(null);
      return;
    }
    setEcsServiceDetailsLoading(true);
    setEcsServicesError(null);
    try {
      const details = await loadEcsTaskTunnelService(hostId, serviceName);
      setEcsServiceDetails(details);
      setDraft((current) => {
        if (!isEcsTaskPortForwardDraft(current) || current.hostId !== hostId || current.serviceName !== serviceName) {
          return current;
        }
        const defaultContainer = details.containers[0];
        const matchedContainer = details.containers.find(
          (container) => container.containerName === current.containerName,
        );
        const activeContainer = matchedContainer ?? defaultContainer;
        const defaultPort = activeContainer?.ports[0]?.port ?? 0;
        return {
          ...current,
          containerName: activeContainer?.containerName ?? '',
          targetPort:
            activeContainer?.ports.some((port) => port.port === current.targetPort)
              ? current.targetPort
              : defaultPort,
        };
      });
    } catch (cause) {
      setEcsServiceDetails(null);
      setEcsServicesError(cause instanceof Error ? cause.message : 'ECS 서비스 상세 정보를 불러오지 못했습니다.');
    } finally {
      setEcsServiceDetailsLoading(false);
    }
  }

  function openCreate(tab: ForwardTab = activeTab) {
    setActiveTab(tab);
    setEditingRuleId(null);
    setEditingDnsOverrideId(null);
    setIsHostPickerOpen(false);
    setIsContainerPickerOpen(false);
    setDraft(
      tab === 'ssh'
        ? emptySshDraft(sshHosts[0]?.id)
        : tab === 'aws-ssm'
          ? emptyAwsDraft(awsHosts[0]?.id)
          : tab === 'ecs-task'
            ? emptyEcsTaskDraft(ecsHosts[0]?.id)
            : tab === 'container'
              ? emptyContainerDraft()
              : emptySshDraft(sshHosts[0]?.id)
    );
    setDnsDraft(emptyDnsDraft(eligibleRules[0]?.id));
    setIsSubmitting(false);
    setError(null);
    resetDiscoveryState();
    resetEcsDiscoveryState();
    setIsModalOpen(true);
  }

  function openEdit(rule: PortForwardRuleRecord) {
    setEditingRuleId(rule.id);
    setEditingDnsOverrideId(null);
    setActiveTab(rule.transport);
    setIsHostPickerOpen(false);
    setIsContainerPickerOpen(false);
    setDraft(toDraft(rule));
    setIsSubmitting(false);
    setError(null);
    resetDiscoveryState();
    resetEcsDiscoveryState();
    setIsModalOpen(true);
  }

  function openEditDnsOverride(override: DnsOverrideResolvedRecord) {
    setEditingRuleId(null);
    setEditingDnsOverrideId(override.id);
    setActiveTab('dns');
    setIsHostPickerOpen(false);
    setIsContainerPickerOpen(false);
    setDnsDraft(
      isLinkedDnsOverrideRecord(override)
        ? {
            type: 'linked',
            hostname: override.hostname,
            portForwardRuleId: override.portForwardRuleId,
          }
        : {
            type: 'static',
            hostname: override.hostname,
            address: override.address,
          },
    );
    setIsSubmitting(false);
    setError(null);
    resetDiscoveryState();
    resetEcsDiscoveryState();
    setIsModalOpen(true);
  }

  function setDnsDraftType(nextType: 'linked' | 'static') {
    setDnsDraft((current) => {
      if (nextType === 'linked') {
        return {
          type: 'linked',
          hostname: current.hostname,
          portForwardRuleId: isLinkedDnsOverrideDraft(current)
            ? current.portForwardRuleId
            : eligibleRules[0]?.id ?? '',
        };
      }

      return {
        type: 'static',
        hostname: current.hostname,
        address: isStaticDnsOverrideDraft(current) ? current.address : '',
      };
    });
  }

  async function closeModal() {
    if (isSubmitting) {
      return;
    }
    setIsModalOpen(false);
    setIsHostPickerOpen(false);
    setIsContainerPickerOpen(false);
    setKnownHostPrompt(null);
    resetEcsDiscoveryState();
    await releaseDiscoveryHost(discoveryHostIdRef.current);
    discoveryHostIdRef.current = null;
  }

  async function probeDiscoveryHost(hostId: string): Promise<boolean> {
    const probe = await probeKnownHost({
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
      const result = await listHostContainers(hostId);
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
      const details = await inspectHostContainer(hostId, containerId);
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
      await replaceKnownHost(input);
    } else {
      await trustKnownHost(input);
    }
    const hostId = knownHostPrompt.probe.hostId;
    setKnownHostPrompt(null);
    await loadContainerList(hostId);
  }

  async function handleSubmit() {
    if (isSubmitting) {
      return;
    }

    if (activeTab === 'dns') {
      if (!isDnsHostname(dnsDraft.hostname)) {
        setError('호스트 이름을 올바르게 입력해 주세요.');
        return;
      }
      if (isLinkedDnsOverrideDraft(dnsDraft)) {
        if (!dnsDraft.portForwardRuleId) {
          setError('연결할 포워딩 규칙을 선택해 주세요.');
          return;
        }
      } else if (!dnsDraft.address.trim()) {
        setError('IP 주소를 입력해 주세요.');
        return;
      }

      setIsSubmitting(true);
      setError(null);
      try {
        const nextDnsDraft: DnsOverrideDraft = isLinkedDnsOverrideDraft(dnsDraft)
          ? {
              type: 'linked',
              hostname: dnsDraft.hostname.trim().toLowerCase(),
              portForwardRuleId: dnsDraft.portForwardRuleId,
            }
          : {
              type: 'static',
              hostname: dnsDraft.hostname.trim().toLowerCase(),
              address: dnsDraft.address.trim(),
            };
        await onSaveDnsOverride(editingDnsOverrideId, nextDnsDraft);
        setIsModalOpen(false);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'DNS override를 저장하지 못했습니다.');
      } finally {
        setIsSubmitting(false);
      }
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

    if (isEcsTaskPortForwardDraft(draft)) {
      if (draft.bindPort < 0) {
        setError('로컬 포트를 올바르게 입력해 주세요.');
        return;
      }
      if (!draft.serviceName.trim()) {
        setError('서비스를 선택해 주세요.');
        return;
      }
      if (!draft.containerName.trim()) {
        setError('컨테이너를 선택해 주세요.');
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
          bindAddress: '127.0.0.1',
          serviceName: draft.serviceName.trim(),
          containerName: draft.containerName.trim(),
        });
        await closeModal();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '포워딩 규칙을 저장하지 못했습니다.');
      } finally {
        setIsSubmitting(false);
      }
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
      if (!isLoopbackBindAddress(draft.bindAddress)) {
        setError('AWS SSM 로컬 주소는 loopback 주소여야 합니다.');
        return;
      }
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
          bindAddress: draft.bindAddress.trim() || '127.0.0.1',
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
    const unsubscribe = onContainersConnectionProgress((event) => {
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

  useEffect(() => {
    if (!isModalOpen || !ecsTaskDraft?.hostId) {
      resetEcsDiscoveryState();
      return;
    }
    void loadEcsServices(ecsTaskDraft.hostId);
  }, [ecsTaskDraft?.hostId, isModalOpen]);

  useEffect(() => {
    if (!isModalOpen || !ecsTaskDraft?.hostId || !ecsTaskDraft.serviceName) {
      setEcsServiceDetails(null);
      return;
    }
    void loadEcsServiceDetails(ecsTaskDraft.hostId, ecsTaskDraft.serviceName);
  }, [ecsTaskDraft?.hostId, ecsTaskDraft?.serviceName, isModalOpen]);

  const discoveryHost = containerDraft ? containerHosts.find((host) => host.id === containerDraft.hostId) ?? null : null;
  const isAutoLocalPort = containerDraft?.bindPort === 0;
  const isAutoEcsLocalPort = ecsTaskDraft?.bindPort === 0;
  const selectedDnsRule = isLinkedDnsOverrideDraft(dnsDraft)
    ? eligibleRules.find((rule) => rule.id === dnsDraft.portForwardRuleId) ?? null
    : null;

  async function handleSetStaticDnsOverrideActive(
    overrideId: string,
    active: boolean,
  ): Promise<void> {
    setDnsToggleError(null);
    setPendingDnsToggleId(overrideId);
    try {
      await onSetStaticDnsOverrideActive(overrideId, active);
      setDnsToggleError(null);
    } catch (cause) {
      setDnsToggleError(
        normalizeErrorMessage(
          cause,
          active
            ? 'DNS Override를 활성화하지 못했습니다.'
            : 'DNS Override를 비활성화하지 못했습니다.',
        ),
      );
    } finally {
      setPendingDnsToggleId((current) =>
        current === overrideId ? null : current,
      );
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-[28px] border border-[color-mix(in_srgb,var(--border)_82%,white_18%)] bg-[var(--surface-elevated)] px-6 py-5 shadow-[var(--shadow-soft)]">
        <div>
          <SectionLabel>Forwarding</SectionLabel>
          <h2 className="mt-2 text-[1.35rem] font-semibold tracking-[-0.02em] text-[var(--text)]">Port Forwarding</h2>
          <p className="mt-2 max-w-[46rem] text-[0.95rem] leading-[1.6] text-[var(--text-soft)]">SSH 포워딩, AWS EC2 포워딩, ECS Task 터널, 컨테이너 터널, DNS Override 규칙을 저장하고 필요할 때만 실행합니다.</p>
        </div>
        <Button type="button" variant="primary" onClick={() => openCreate(activeTab)}>
          {createButtonLabel(activeTab)}
        </Button>
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

      <Tabs role="tablist" aria-label="Port forwarding transport" className="gap-2 bg-[var(--surface-elevated)] p-1.5">
        <TabButton role="tab" aria-selected={activeTab === 'ssh'} active={activeTab === 'ssh'} onClick={() => setActiveTab('ssh')}>
          SSH Forwarding
        </TabButton>
        <TabButton role="tab" aria-selected={activeTab === 'aws-ssm'} active={activeTab === 'aws-ssm'} onClick={() => setActiveTab('aws-ssm')}>
          AWS EC2
        </TabButton>
        <TabButton role="tab" aria-selected={activeTab === 'ecs-task'} active={activeTab === 'ecs-task'} onClick={() => setActiveTab('ecs-task')}>
          ECS Task
        </TabButton>
        <TabButton role="tab" aria-selected={activeTab === 'container'} active={activeTab === 'container'} onClick={() => setActiveTab('container')}>
          Container
        </TabButton>
        <TabButton role="tab" aria-selected={activeTab === 'dns'} active={activeTab === 'dns'} onClick={() => setActiveTab('dns')}>
          DNS Override
        </TabButton>
      </Tabs>

      <div className="operations-list">
        {activeTab === 'dns' && dnsToggleError ? (
          <div className="terminal-error-banner" role="alert">
            {dnsToggleError}
          </div>
        ) : null}
        {activeTab === 'dns' ? (
          !hasVisibleEntries ? (
            <EmptyState title={emptyStateTitle(activeTab)} description={emptyStateDescription(activeTab)} />
          ) : (
            dnsOverrides.map((override) => {
              const rule = isLinkedDnsOverrideRecord(override)
                ? (ruleMap.get(override.portForwardRuleId) ?? null)
                : null;
              const runtime = rule ? runtimeMap.get(rule.id) : undefined;
              const isRunning = runtime?.status === 'running' || runtime?.status === 'starting';
              const isStatic = isStaticDnsOverrideRecord(override);

              return (
                <Card key={override.id} className="operations-card">
                  <CardMain className="operations-card__main">
                    <CardTitleRow className="operations-card__title-row">
                      <strong>{override.hostname}</strong>
                      <Badge>{isStatic ? 'Static' : 'Linked'}</Badge>
                      <StatusBadge tone={getRuntimeStatusTone(isStatic ? (override.status === 'active' ? 'running' : 'stopped') : runtime?.status)}>
                        {isStatic ? (override.status === 'active' ? 'On' : 'Off') : statusLabel(runtime)}
                      </StatusBadge>
                    </CardTitleRow>
                    <CardMeta className="operations-card__meta">
                      <span>Hosts file</span>
                      <span>{isStatic ? 'Static IP' : rule?.label ?? 'Linked rule missing'}</span>
                      <span>
                        {isStatic
                          ? override.address
                          : `${runtime?.bindAddress ?? rule?.bindAddress ?? '127.0.0.1'}:${runtime?.bindPort ?? rule?.bindPort ?? 0}`}
                      </span>
                    </CardMeta>
                    {!isStatic && runtime?.message ? <CardMessage className="operations-card__message">{runtime.message}</CardMessage> : null}
                  </CardMain>
                  <CardActions className="operations-card__actions">
                    {rule ? (
                      <Button type="button" variant="secondary" size="sm" onClick={() => void (isRunning ? onStop(rule.id) : onStart(rule.id))}>
                        {isRunning ? 'Stop' : 'Start'}
                      </Button>
                    ) : null}
                    {isStatic ? (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => void handleSetStaticDnsOverrideActive(override.id, override.status !== 'active')}
                        disabled={pendingDnsToggleId === override.id}
                      >
                        {override.status === 'active' ? 'Off' : 'On'}
                      </Button>
                    ) : null}
                    <Button type="button" variant="secondary" size="sm" onClick={() => openEditDnsOverride(override)}>
                      Edit
                    </Button>
                    <Button type="button" variant="danger" size="sm" onClick={() => void onRemoveDnsOverride(override.id)}>
                      Delete
                    </Button>
                  </CardActions>
                </Card>
              );
            })
          )
        ) : !hasVisibleEntries ? (
          <EmptyState title={emptyStateTitle(activeTab)} description={emptyStateDescription(activeTab)} />
        ) : (
          <>
            {activeTab === 'ecs-task' && visibleEcsEphemeralRuntimes.length > 0 ? (
              <section className="operations-section">
                <div className="operations-section__title">Running tunnels</div>
                {visibleEcsEphemeralRuntimes.map(renderEcsEphemeralRuntimeCard)}
              </section>
            ) : null}

            {activeTab === 'container' &&
            visibleContainerEphemeralRuntimes.length > 0 ? (
              <section className="operations-section">
                <div className="operations-section__title">Running tunnels</div>
                {visibleContainerEphemeralRuntimes.map(
                  renderContainerEphemeralRuntimeCard,
                )}
              </section>
            ) : null}

            {visibleRules.length > 0 ? (
              <section className="operations-section">
                {activeTab === 'ecs-task' || activeTab === 'container' ? (
                  <div className="operations-section__title">Saved rules</div>
                ) : null}
                {visibleRules.map(renderRuleCard)}
              </section>
            ) : null}
          </>
        )}
      </div>

      {isModalOpen ? (
        <DialogBackdrop onDismiss={() => void closeModal()} dismissDisabled={isSubmitting}>
          <ModalShell
            className={`port-forwarding-modal ${isContainerPortForwardDraft(draft) ? 'port-forwarding-modal--container' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="port-forward-title"
          >
            <ModalHeader className="port-forwarding-modal__header">
              <div>
                <SectionLabel>Forwarding</SectionLabel>
                <h3 id="port-forward-title" className="mt-2">
                  {activeTab === 'dns'
                    ? editingDnsOverrideId
                      ? 'Edit DNS Override'
                      : 'New DNS Override'
                    : editingRuleId
                      ? `Edit ${tabTitle(activeTab)}`
                      : createButtonLabel(activeTab)}
                </h3>
              </div>
              <IconButton
                type="button"
                tone="ghost"
                onClick={() => void closeModal()}
                disabled={isSubmitting}
                aria-label="Close port forwarding dialog"
              >
                &times;
              </IconButton>
            </ModalHeader>

            <ModalBody className="port-forwarding-modal__body form-grid">
              {activeTab === 'dns' ? (
                <>
                  <label className="form-field">
                    <span>Override type</span>
                    <select
                      value={dnsDraft.type}
                      onChange={(event) => setDnsDraftType(event.target.value === 'static' ? 'static' : 'linked')}
                      disabled={isSubmitting}
                    >
                      <option value="linked">Linked</option>
                      <option value="static">Static</option>
                    </select>
                  </label>

                  <label className="form-field">
                    <span>Hostname</span>
                    <input
                      value={dnsDraft.hostname}
                      onChange={(event) => setDnsDraft((current) => ({ ...current, hostname: event.target.value }))}
                      disabled={isSubmitting}
                    />
                  </label>

                  {isLinkedDnsOverrideDraft(dnsDraft) ? (
                    <>
                      <label className="form-field">
                        <span>Linked rule</span>
                        <select
                          value={dnsDraft.portForwardRuleId}
                          onChange={(event) =>
                            setDnsDraft((current) =>
                              isLinkedDnsOverrideDraft(current)
                                ? { ...current, portForwardRuleId: event.target.value }
                                : current
                            )
                          }
                          disabled={isSubmitting}
                        >
                          <option value="">Select port forward rule</option>
                          {eligibleRules.map((rule) => (
                            <option key={rule.id} value={rule.id}>
                              {rule.label} ({rule.bindAddress}:{rule.bindPort})
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="form-field">
                        <span>Loopback target</span>
                        <input value={selectedDnsRule ? `${selectedDnsRule.bindAddress}:${selectedDnsRule.bindPort}` : ''} disabled readOnly />
                      </label>
                    </>
                  ) : (
                    <>
                      <label className="form-field">
                        <span>IP Address</span>
                        <input
                          value={dnsDraft.address}
                          onChange={(event) =>
                            setDnsDraft((current) =>
                              isStaticDnsOverrideDraft(current)
                                ? { ...current, address: event.target.value }
                                : current
                            )
                          }
                          disabled={isSubmitting}
                        />
                      </label>
                    </>
                  )}

                  {error ? <div className="form-error">{error}</div> : null}
                </>
              ) : (
                <>
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
                  <span>{isAwsSsmPortForwardDraft(draft) ? 'AWS EC2 Host' : isEcsTaskPortForwardDraft(draft) ? 'AWS ECS Host' : 'Host'}</span>
                  <select
                    value={draft.hostId}
                    onChange={(event) => {
                      const nextHostId = event.target.value;
                      setDraft((current) =>
                        isEcsTaskPortForwardDraft(current)
                          ? {
                              ...current,
                              hostId: nextHostId,
                              serviceName: '',
                              containerName: '',
                              targetPort: 0,
                            }
                          : { ...current, hostId: nextHostId }
                      );
                    }}
                    disabled={isSubmitting}
                  >
                    <option value="">Select host</option>
                    {(isAwsSsmPortForwardDraft(draft)
                      ? awsHosts
                      : isEcsTaskPortForwardDraft(draft)
                        ? ecsHosts
                        : sshHosts).map((host) => (
                      <option key={host.id} value={host.id}>
                        {isAwsEc2HostRecord(host)
                          ? `${host.label} (${host.awsProfileName} / ${host.awsRegion} / ${host.awsInstanceId})`
                          : isAwsEcsHostRecord(host)
                            ? `${host.label} (${host.awsProfileName} / ${host.awsRegion} / ${host.awsEcsClusterName})`
                          : `${host.label} (${host.hostname})`}
                      </option>
                    ))}
                  </select>
                </label>
              )}

              {isContainerPortForwardDraft(draft) ? (
                <>
                  {shouldShowDiscoveryProgress ? (
                    <NoticeCard title="Container discovery">
                      <p>{discoveryProgressMessage}</p>
                    </NoticeCard>
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
                            <StatusBadge
                              tone={getDiscoveryContainerStatusPresentation(selectedContainerSummary.status).tone}
                              className="port-forward-picker__status-badge"
                            >
                              {getDiscoveryContainerStatusPresentation(selectedContainerSummary.status).label}
                            </StatusBadge>
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
                            <StatusBadge
                              tone={statusPresentation.tone}
                              className="port-forward-picker__status-badge"
                            >
                              {statusPresentation.label}
                            </StatusBadge>
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
                  {discoveryDetailsLoading ? (
                    <NoticeCard>
                      <p>컨테이너 상세 정보를 불러오는 중입니다.</p>
                    </NoticeCard>
                  ) : null}
                  {discoveryDetails && eligiblePorts.length === 0 ? (
                    <EmptyState
                      title="선택 가능한 TCP 포트가 없습니다."
                      description="이 컨테이너에는 포워딩에 사용할 TCP 포트가 감지되지 않았습니다."
                    />
                  ) : null}
                  {discoveryDetails && availableNetworks.length === 0 ? (
                    <EmptyState
                      title="사용 가능한 네트워크 IP가 없습니다."
                      description="이 컨테이너는 연결할 네트워크 정보가 없어 터널 규칙을 저장할 수 없습니다."
                    />
                  ) : null}
                  {discoveryDetails && availableNetworks.length > 0 && eligibleNetworks.length === 0 ? (
                    <NoticeCard title="현재는 네트워크 IP가 보이지 않습니다.">
                      <p>종료된 컨테이너일 수 있습니다. 규칙은 저장할 수 있고, 시작할 때 현재 IP를 다시 확인합니다.</p>
                    </NoticeCard>
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
              ) : isEcsTaskPortForwardDraft(draft) ? (
                <>
                  <label className="form-field">
                    <span>Service</span>
                    <select
                      value={draft.serviceName}
                      onChange={(event) =>
                        setDraft((current) =>
                          isEcsTaskPortForwardDraft(current)
                            ? {
                                ...current,
                                serviceName: event.target.value,
                                containerName: '',
                                targetPort: 0,
                              }
                            : current
                        )
                      }
                      disabled={isSubmitting || ecsServicesLoading || !draft.hostId}
                    >
                      <option value="">Select service</option>
                      {ecsServices.map((service) => (
                        <option key={service.serviceName} value={service.serviceName}>
                          {service.serviceName} ({service.runningCount}/{service.desiredCount})
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="form-field">
                    <span>Container</span>
                    <select
                      value={draft.containerName}
                      onChange={(event) =>
                        setDraft((current) =>
                          isEcsTaskPortForwardDraft(current)
                            ? {
                                ...current,
                                containerName: event.target.value,
                                targetPort:
                                  ecsServiceDetails?.containers.find(
                                    (container) => container.containerName === event.target.value,
                                  )?.ports[0]?.port ?? 0,
                              }
                            : current
                        )
                      }
                      disabled={isSubmitting || ecsServiceDetailsLoading || !draft.serviceName}
                    >
                      <option value="">Select container</option>
                      {ecsContainerOptions.map((container) => (
                        <option key={container.containerName} value={container.containerName}>
                          {container.containerName}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="form-field">
                    <span>Container port</span>
                    <select
                      value={draft.targetPort || ''}
                      onChange={(event) =>
                        setDraft((current) =>
                          isEcsTaskPortForwardDraft(current)
                            ? {
                                ...current,
                                targetPort: Number(event.target.value),
                              }
                            : current
                        )
                      }
                      disabled={isSubmitting || !draft.containerName}
                    >
                      <option value="">Select TCP port</option>
                      {ecsPortOptions.map((port) => (
                        <option key={`${port.protocol}-${port.port}`} value={port.port}>
                          {port.port}/{port.protocol}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="form-field">
                    <span>Local port</span>
                    <div className="port-forward-local-port">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isAutoEcsLocalPort}
                        aria-label="Auto (random)"
                        className={`port-forward-toggle ${isAutoEcsLocalPort ? 'is-active' : ''}`}
                        onClick={() =>
                          setDraft((current) =>
                            isEcsTaskPortForwardDraft(current)
                              ? {
                                  ...current,
                                  bindPort: isAutoEcsLocalPort ? 9000 : 0,
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
                        value={isAutoEcsLocalPort ? '' : draft.bindPort}
                        onChange={(event) =>
                          setDraft((current) =>
                            isEcsTaskPortForwardDraft(current)
                              ? {
                                  ...current,
                                  bindPort: Number(event.target.value),
                                }
                              : current
                          )
                        }
                        disabled={isSubmitting || isAutoEcsLocalPort}
                        placeholder={isAutoEcsLocalPort ? '자동 할당' : '9000'}
                      />
                    </div>
                  </label>

                  {selectedEcsHost ? (
                    <NoticeCard title={selectedEcsHost.awsEcsClusterName}>
                      <p>{selectedEcsHost.awsProfileName} / {selectedEcsHost.awsRegion}</p>
                    </NoticeCard>
                  ) : null}
                  {ecsServicesError ? <div className="form-error">{ecsServicesError}</div> : null}
                  {ecsServicesLoading ? <NoticeCard><p>ECS 서비스 목록을 불러오는 중입니다.</p></NoticeCard> : null}
                  {ecsServiceDetailsLoading ? <NoticeCard><p>ECS 서비스 상세 정보를 불러오는 중입니다.</p></NoticeCard> : null}
                  {!ecsServicesLoading && draft.hostId && ecsServices.length === 0 && !ecsServicesError ? (
                    <EmptyState
                      title="가져올 수 있는 ECS 서비스가 없습니다."
                      description="이 클러스터에는 포트 포워딩에 사용할 서비스가 없습니다."
                    />
                  ) : null}
                  {!ecsServiceDetailsLoading && draft.serviceName && ecsServiceDetails && ecsContainerOptions.length === 0 ? (
                    <EmptyState
                      title="선택 가능한 컨테이너가 없습니다."
                      description="이 서비스의 task definition에 사용할 컨테이너가 없습니다."
                    />
                  ) : null}
                  {!ecsServiceDetailsLoading && draft.containerName && ecsPortOptions.length === 0 ? (
                    <EmptyState
                      title="선택 가능한 TCP 포트가 없습니다."
                      description="이 컨테이너에는 포워딩에 사용할 TCP 포트가 감지되지 않았습니다."
                    />
                  ) : null}
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
              )}

              {!isContainerPortForwardDraft(draft) && !isEcsTaskPortForwardDraft(draft) ? (
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
                </>
              )}
            </ModalBody>

            <ModalFooter className="port-forwarding-modal__footer">
              <Button type="button" variant="secondary" onClick={() => void closeModal()} disabled={isSubmitting}>
                취소
              </Button>
              <Button
                type="button"
                variant="primary"
                onClick={() => void handleSubmit()}
                disabled={
                  isSubmitting ||
                  (isEcsTaskPortForwardDraft(draft) &&
                    (!draft.serviceName || !draft.containerName || !draft.targetPort)) ||
                  (isContainerPortForwardDraft(draft) &&
                    (!draft.containerId || !draft.networkName || !draft.targetPort || availableNetworks.length === 0 || eligiblePorts.length === 0))
                }
              >
                저장
              </Button>
            </ModalFooter>
          </ModalShell>
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
