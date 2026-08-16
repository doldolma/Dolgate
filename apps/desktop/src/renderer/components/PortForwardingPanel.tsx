import { type ComponentProps, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown } from '../ui/icons';
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
import { formatInteractiveHop, normalizeErrorMessage } from '../store/utils';
import { cn } from '../lib/cn';
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
  CloseIcon,
  EmptyState,
  FieldGroup,
  IconButton,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  PanelSection,
  SearchableSelect,
  type SearchableSelectOption,
  SectionLabel,
  SelectField,
  StatusBadge,
  TabButton,
  Tabs,
} from '../ui';
import { DialogBackdrop } from './DialogBackdrop';
import { KnownHostPromptDialog } from './KnownHostPromptDialog';
import { Trans, useTranslation } from 'react-i18next';
import { ConnectionProgressModal } from './ConnectionProgressModal';
import { useAppStore } from '../store/appStore';
import { t } from '../i18n';

type ForwardTab = 'ssh' | 'aws-ssm' | 'ecs-task' | 'container' | 'dns';
type SshForwardHostRecord = Extract<HostRecord, { kind: 'ssh' }>;
type AwsEc2ForwardHostRecord = Extract<HostRecord, { kind: 'aws-ec2' }>;
type AwsEcsForwardHostRecord = Extract<HostRecord, { kind: 'aws-ecs' }>;

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
  /** 카드를 내린다. 어느 것인지 반드시 지목한다 — 인자가 없으면 스토어가 전부 비운다. */
  onClearInteractiveAuth: (challengeId?: string) => void;
}

interface InteractiveAuthFormProps {
  auth: PendingContainersInteractiveAuth | PendingPortForwardInteractiveAuth;
  title: string;
  onRespond: (challengeId: string, responses: string[]) => Promise<void>;
  onReopenUrl: () => Promise<void>;
  /**
   * 취소/닫기. **인자를 받지 않는 형태로 유지한다.**
   *
   * 예전에는 이 함수를 Button 의 onClick 에 그대로 넘겨서 클릭 이벤트가 첫 인자로 들어갔고,
   * clearPendingInteractiveAuth(challengeId?) 가 그 이벤트를 challengeId 로 받아 아무것도 지우지
   * 못했다 — 실기기에서 취소 버튼이 먹통이었다. 호출은 항상 `() => onCancel()` 로 감싼다.
   */
  onCancel: () => void;
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
  if (host.kind === 'serial') {
    if (host.transport === 'local') {
      return host.devicePath ?? 'Local serial port';
    }
    return `${host.transport} / ${host.host ?? ''}:${host.port ?? ''}`.replace(/:$/, '');
  }
  return host.hostname;
}

function getSshForwardHostSecondaryLabel(host: SshForwardHostRecord): string {
  const endpoint = `${host.hostname}:${host.port}`;
  const username = host.username?.trim();
  return username ? `${username}@${endpoint}` : endpoint;
}

function getSshForwardHostSearchText(host: SshForwardHostRecord): string {
  return [
    host.label,
    host.hostname,
    host.username ?? '',
    host.groupName ?? '',
    getSshForwardHostSecondaryLabel(host),
    ...(host.tags ?? []),
  ].join(' ');
}

function getAwsSsmForwardHostSecondaryLabel(host: AwsEc2ForwardHostRecord): string {
  return `${host.awsProfileName} / ${host.awsRegion} / ${host.awsInstanceId}`;
}

function getEcsTaskForwardHostSecondaryLabel(host: AwsEcsForwardHostRecord): string {
  return `${host.awsProfileName} / ${host.awsRegion} / ${host.awsEcsClusterName}`;
}

function getPortForwardHostSearchText(host: HostRecord): string {
  const base = [host.label, host.groupName ?? '', ...(host.tags ?? [])];
  if (isSshHostRecord(host)) {
    return [...base, getSshForwardHostSearchText(host)].join(' ');
  }
  if (isAwsEc2HostRecord(host)) {
    return [
      ...base,
      host.awsProfileName,
      host.awsRegion,
      host.awsInstanceId,
      host.awsInstanceName ?? '',
      host.awsPrivateIp ?? '',
      host.awsState,
      getAwsSsmForwardHostSecondaryLabel(host),
    ].join(' ');
  }
  if (isAwsEcsHostRecord(host)) {
    return [
      ...base,
      host.awsProfileName,
      host.awsRegion,
      host.awsEcsClusterArn,
      host.awsEcsClusterName,
      getEcsTaskForwardHostSecondaryLabel(host),
    ].join(' ');
  }
  return [...base, getContainerHostSecondaryLabel(host)].join(' ');
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
    return t('portForward.empty.sshTitle');
  }
  if (tab === 'aws-ssm') {
    return t('portForward.empty.awsTitle');
  }
  if (tab === 'ecs-task') {
    return t('portForward.empty.ecsTitle');
  }
  if (tab === 'dns') {
    return t('portForward.empty.dnsTitle');
  }
  return t('portForward.empty.containerTitle');
}

function emptyStateDescription(tab: ForwardTab) {
  if (tab === 'ssh') {
    return t('portForward.empty.sshDescription');
  }
  if (tab === 'aws-ssm') {
    return t('portForward.empty.awsDescription');
  }
  if (tab === 'ecs-task') {
    return t('portForward.empty.ecsDescription');
  }
  if (tab === 'dns') {
    return t('portForward.empty.dnsDescription');
  }
  return t('portForward.empty.containerDescription');
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

/** 이 인증을 요구하는 포워딩의 이름. 규칙 라벨 → 호스트 라벨 → 이름 없는 문구 순으로 고른다. */
function resolveForwardAuthTitle(
  translate: (key: string, values?: Record<string, string>) => string,
  rules: PortForwardRuleRecord[],
  hosts: HostRecord[],
  auth: PendingPortForwardInteractiveAuth,
): string {
  const label =
    rules.find((rule) => rule.id === auth.ruleId)?.label?.trim() ||
    hosts.find((host) => host.id === auth.hostId)?.label?.trim() ||
    '';
  return label
    ? translate('portForward.waiting.forwardAuth', { label })
    : translate('portForward.waiting.forwardAuthUnnamed');
}

function InteractiveAuthCard({ auth, title, onRespond, onReopenUrl, onCancel }: InteractiveAuthFormProps) {
  const { t: translate } = useTranslation();
  // 코어는 주소만 준다 — 사용자가 붙인 이름은 여기서 얹는다.
  const hosts = useAppStore((state) => state.hosts);
  const [responses, setResponses] = useState<InteractivePromptResponses>({});
  const warpgateResponses = useMemo(
    () => (auth.provider === 'warpgate' ? resolveWarpgateResponses(auth) : null),
    [auth]
  );

  useEffect(() => {
    setResponses({});
  }, [auth.challengeId]);

  // 점프 체인에서 누구의 코드를 묻는지. 없으면 베스천과 최종 대상을 구분할 수 없다.
  const hopLabel = formatInteractiveHop(auth.hop, hosts);

  return (
    <NoticeCard title={title} className="mt-4">
      {hopLabel ? (
        <p className="mb-3 flex flex-wrap items-baseline gap-2 text-sm text-[var(--text-soft)]">
          <span>{translate('authOverlay.hopLabel')}</span>
          <code className="rounded-[6px] bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] px-1.5 py-0.5 text-[0.82rem] break-all text-[var(--text)]">
            {hopLabel}
          </code>
        </p>
      ) : null}
      {auth.provider === 'warpgate' ? (
        <>
          <p>{translate('portForward.warpgate.browserHint')}</p>
          {auth.authCode ? (
            <p className="text-sm text-[var(--text-soft)]">
              <Trans
                i18nKey="portForward.warpgate.authCodeNote"
                values={{ code: auth.authCode }}
                components={{ code: <code /> }}
              />
            </p>
          ) : null}
          <div className="mt-3 flex flex-wrap gap-3">
            {auth.approvalUrl ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => void onReopenUrl()}>
                {translate('portForward.warpgate.reopenBrowser')}
              </Button>
            ) : null}
            <Button type="button" variant="ghost" size="sm" onClick={() => onCancel()}>
              {translate('common.close')}
            </Button>
          </div>
          {warpgateResponses ? null : (
            <NoticeCard title={translate('portForward.warpgate.manualTitle')} className="mt-3">
              <p>{translate('portForward.warpgate.manualHint')}</p>
            </NoticeCard>
          )}
          <pre className="mt-3 rounded-[10px] bg-[color-mix(in_srgb,var(--surface)_88%,transparent_12%)] px-3 py-2 text-[0.82rem] text-[var(--text-soft)] whitespace-pre-wrap break-words">
            {auth.instruction || translate('portForward.warpgate.fallbackInstruction')}
          </pre>
        </>
      ) : (
        <p>{auth.instruction || translate('portForward.warpgate.fallbackInstruction')}</p>
      )}
      {auth.provider !== 'warpgate' && auth.approvalUrl ? (
        <div className="mt-3 flex flex-wrap gap-3">
          <Button type="button" variant="secondary" size="sm" onClick={() => void onReopenUrl()}>
            {translate('portForward.warpgate.reopenBrowser')}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={() => onCancel()}>
            {translate('common.close')}
          </Button>
        </div>
      ) : null}
      {(auth.provider !== 'warpgate' || !warpgateResponses) && auth.prompts.length > 0 ? (
        <div className="mt-4 grid gap-4">
          {auth.prompts.map((prompt, index) => (
            <FieldGroup
              key={`${auth.challengeId}-${index}`}
              label={prompt.label || `Prompt ${index + 1}`}
            >
              <Input
                // 가릴지는 코어가 판정한다(prompt.masked). 일회용 코드는 가리지 않는다 —
                // 서버가 echo 를 끄고 보내지만, 그것까지 가리면 여섯 자리를 확인하지 못한 채
                // 보내야 한다. 비밀번호는 그대로 가린다.
                type={prompt.masked ? 'password' : 'text'}
                value={responses[index] ?? ''}
                onChange={(event) =>
                  setResponses((current) => ({
                    ...current,
                    [index]: event.target.value
                  }))
                }
              />
            </FieldGroup>
          ))}
          <div className="mt-3 flex items-center justify-end gap-3">
            <Button type="button" variant="secondary" onClick={() => onCancel()}>
              {translate('common.cancel')}
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
              {translate('portForward.warpgate.continue')}
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
    <FieldGroup label={label} className="relative">
      <button
        type="button"
        className={cn(
          'flex w-full min-h-[var(--port-forward-field-height,88px)] items-center justify-between gap-[0.9rem] rounded-[var(--port-forward-field-radius,20px)] border border-[var(--border)] bg-[var(--dialog-surface-muted)] px-[1.1rem] py-4 text-left text-[var(--text)] transition-[border-color,box-shadow,transform] duration-150',
          isOpen
            ? 'border-[color-mix(in_srgb,var(--accent-strong)_34%,var(--border))] shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent-strong)_20%,transparent_80%)]'
            : 'hover:border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border))] hover:shadow-[0_10px_24px_rgba(16,26,40,0.08)]',
          disabled && 'cursor-not-allowed opacity-70 shadow-none',
        )}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={label}
        onClick={onToggle}
        disabled={disabled}
      >
        {selectedContent ? (
          selectedContent
        ) : (
          <div className="text-[var(--text-soft)]">{placeholder}</div>
        )}
        <ChevronDown
          className="h-[0.9rem] w-[0.9rem] shrink-0 text-[var(--text-soft)]"
          aria-hidden="true"
        />
      </button>
      {isOpen ? (
        <div
          className="absolute left-0 right-0 top-[calc(100%+0.45rem)] z-[4] grid max-h-[288px] gap-[0.55rem] overflow-y-auto rounded-[12px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--dialog-surface)_94%,transparent_6%)] p-[0.7rem] shadow-[0_20px_48px_rgba(16,26,40,0.18)]"
          role="listbox"
          aria-label={`${label} options`}
        >
          {children}
        </div>
      ) : null}
    </FieldGroup>
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
  const { t: translate } = useTranslation();
  // 진행 중인 연결이 있으면 터미널과 같은 화면을 팝업으로 띄운다.
  //
  // 시작 버튼이 규칙 종류마다 흩어져 있어서 각 버튼에 매다는 대신, **뷰가 생기면 뜨는** 방식을
  // 쓴다 — 시작 경로가 하나 더 생겨도 여기 손댈 일이 없다.
  const connectionViews = useAppStore((state) => state.connectionViews);
  const dismissConnectionView = useAppStore((state) => state.dismissConnectionView);
  const connectingRule = rules.find((rule) => connectionViews[rule.id]) ?? null;
  const connectingHost = connectingRule
    ? (hosts.find((host) => host.id === connectingRule.hostId) ?? null)
    : null;
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
  const [isContainerPickerOpen, setIsContainerPickerOpen] = useState(false);
  const [knownHostPrompt, setKnownHostPrompt] = useState<PendingHostKeyPrompt | null>(null);
  const discoveryHostIdRef = useRef<string | null>(null);
  const discoveryListRequestRef = useRef(0);
  const discoveryDetailsRequestRef = useRef(0);
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
  const sshDraft = isSshPortForwardDraft(draft) ? draft : null;
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
  const sshHostOptions = useMemo<SearchableSelectOption[]>(
    () =>
      sshHosts.map((host) => ({
        value: host.id,
        label: host.label,
        description: getSshForwardHostSecondaryLabel(host),
        badge: 'SSH',
        searchText: getPortForwardHostSearchText(host),
      })),
    [sshHosts],
  );
  const awsHostOptions = useMemo<SearchableSelectOption[]>(
    () =>
      awsHosts.map((host) => ({
        value: host.id,
        label: host.label,
        description: getAwsSsmForwardHostSecondaryLabel(host),
        badge: 'AWS',
        searchText: getPortForwardHostSearchText(host),
      })),
    [awsHosts],
  );
  const selectedEcsHost = ecsTaskDraft ? ecsHosts.find((host) => host.id === ecsTaskDraft.hostId) ?? null : null;
  const ecsHostOptions = useMemo<SearchableSelectOption[]>(
    () =>
      ecsHosts.map((host) => ({
        value: host.id,
        label: host.label,
        description: getEcsTaskForwardHostSecondaryLabel(host),
        badge: 'ECS',
        searchText: getPortForwardHostSearchText(host),
      })),
    [ecsHosts],
  );
  const containerHostOptions = useMemo<SearchableSelectOption[]>(
    () =>
      containerHosts.map((host) => ({
        value: host.id,
        label: host.label,
        description: getContainerHostSecondaryLabel(host),
        badge: getContainerHostKindLabel(host),
        searchText: getPortForwardHostSearchText(host),
      })),
    [containerHosts],
  );
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

  function selectSshForwardHost(hostId: string) {
    setDraft((current) => {
      if (!isSshPortForwardDraft(current)) {
        return current;
      }
      return {
        ...current,
        hostId,
      };
    });
  }

  function selectAwsForwardHost(hostId: string) {
    setDraft((current) => {
      if (!isAwsSsmPortForwardDraft(current)) {
        return current;
      }
      return {
        ...current,
        hostId,
      };
    });
  }

  function selectEcsForwardHost(hostId: string) {
    setDraft((current) => {
      if (!isEcsTaskPortForwardDraft(current)) {
        return current;
      }
      return {
        ...current,
        hostId,
        serviceName: '',
        containerName: '',
        targetPort: 0,
      };
    });
  }

  function selectContainerForwardHost(hostId: string) {
    setDraft((current) => {
      if (!isContainerPortForwardDraft(current)) {
        return current;
      }
      return {
        ...current,
        hostId,
        containerId: '',
        containerName: '',
        networkName: '',
        targetPort: 0,
      };
    });
  }


  function renderRuleCard(rule: PortForwardRuleRecord) {
    const runtime = runtimeMap.get(rule.id);
    const isRunning =
      runtime?.status === 'running' || runtime?.status === 'starting';

    if (isAwsSsmPortForwardRuleRecord(rule)) {
      const host = awsHosts.find((item) => item.id === rule.hostId);
      return (
        <Card
          key={rule.id}
          className="items-start max-[760px]:flex-col max-[760px]:items-stretch"
        >
          <CardMain>
            <CardTitleRow>
              <strong>{rule.label}</strong>
              <StatusBadge tone={getRuntimeStatusTone(runtime?.status)}>
                {statusLabel(runtime)}
              </StatusBadge>
            </CardTitleRow>
            <CardMeta>
              <span>AWS EC2</span>
              {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
              <span>
                {host ? `${host.label} (${host.awsProfileName} / ${host.awsRegion} / ${host.awsInstanceId})` : 'Unknown AWS host'}
              </span>
              <span>{(runtime?.bindAddress ?? rule.bindAddress) || '127.0.0.1'}:{runtime?.bindPort ?? rule.bindPort}</span>
              <span>{rule.targetKind === 'remote-host' ? `${rule.remoteHost}:${rule.targetPort}` : `instance:${rule.targetPort}`}</span>
            </CardMeta>
            {runtime?.message ? <CardMessage>{runtime.message}</CardMessage> : null}
          </CardMain>
          <CardActions className="max-[760px]:w-full max-[760px]:[&>*]:flex-1">
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
        <Card
          key={rule.id}
          className="items-start max-[760px]:flex-col max-[760px]:items-stretch"
        >
          <CardMain>
            <CardTitleRow>
              <strong>{rule.label}</strong>
              <StatusBadge tone={getRuntimeStatusTone(runtime?.status)}>
                {statusLabel(runtime)}
              </StatusBadge>
            </CardTitleRow>
            <CardMeta>
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
            {runtime?.message ? <CardMessage>{runtime.message}</CardMessage> : null}
          </CardMain>
          <CardActions className="max-[760px]:w-full max-[760px]:[&>*]:flex-1">
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
        <Card
          key={rule.id}
          className="items-start max-[760px]:flex-col max-[760px]:items-stretch"
        >
          <CardMain>
            <CardTitleRow>
              <strong>{rule.label}</strong>
              <StatusBadge tone={getRuntimeStatusTone(runtime?.status)}>
                {statusLabel(runtime)}
              </StatusBadge>
            </CardTitleRow>
            <CardMeta>
              <span>Container</span>
              {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
              <span>{host ? host.label : 'Unknown host'}</span>
              <span>{rule.containerName} ({rule.containerRuntime})</span>
              <span>{runtime?.bindAddress ?? '127.0.0.1'}:{(runtime?.bindPort ?? rule.bindPort) || 'auto'}</span>
              <span>{rule.networkName}:{rule.targetPort}</span>
            </CardMeta>
            {runtime?.message ? <CardMessage>{runtime.message}</CardMessage> : null}
          </CardMain>
          <CardActions className="max-[760px]:w-full max-[760px]:[&>*]:flex-1">
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
      <Card
        key={rule.id}
        className="items-start max-[760px]:flex-col max-[760px]:items-stretch"
      >
        <CardMain>
          <CardTitleRow>
            <strong>{rule.label}</strong>
            <StatusBadge tone={getRuntimeStatusTone(runtime?.status)}>
              {statusLabel(runtime)}
            </StatusBadge>
          </CardTitleRow>
          <CardMeta>
            <span>{rule.mode.toUpperCase()}</span>
            {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
            <span>{host ? `${host.label} (${host.hostname})` : 'Unknown SSH host'}</span>
            <span>{rule.bindAddress}:{runtime?.bindPort ?? rule.bindPort}</span>
            <span>{rule.mode === 'dynamic' ? 'SOCKS5' : `${rule.targetHost}:${rule.targetPort}`}</span>
          </CardMeta>
          {runtime?.message ? <CardMessage>{runtime.message}</CardMessage> : null}
        </CardMain>
        <CardActions className="max-[760px]:w-full max-[760px]:[&>*]:flex-1">
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
      <Card
        key={runtime.ruleId}
        className="items-start max-[760px]:flex-col max-[760px]:items-stretch"
      >
        <CardMain>
          <CardTitleRow>
            <strong>{serviceName}</strong>
            <Badge>Ephemeral</Badge>
            <StatusBadge tone={getRuntimeStatusTone(runtime.status)}>
              {statusLabel(runtime)}
            </StatusBadge>
          </CardTitleRow>
          <CardMeta>
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
          {runtime.message ? <CardMessage>{runtime.message}</CardMessage> : null}
        </CardMain>
        <CardActions className="max-[760px]:w-full max-[760px]:[&>*]:flex-1">
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
      <Card
        key={runtime.ruleId}
        className="items-start max-[760px]:flex-col max-[760px]:items-stretch"
      >
        <CardMain>
          <CardTitleRow>
            <strong>{containerName}</strong>
            <Badge>Ephemeral</Badge>
            <StatusBadge tone={getRuntimeStatusTone(runtime.status)}>
              {statusLabel(runtime)}
            </StatusBadge>
          </CardTitleRow>
          <CardMeta>
            <span>Container</span>
            {runtimeMethodLabel(runtime) ? <span>{runtimeMethodLabel(runtime)}</span> : null}
            <span>{host?.label ?? 'Unknown host'}</span>
            <span>{containerName}</span>
            <span>{runtime.bindAddress}:{runtime.bindPort}</span>
            <span>{networkName}:{targetPort}</span>
          </CardMeta>
          {runtime.message ? <CardMessage>{runtime.message}</CardMessage> : null}
        </CardMain>
        <CardActions className="max-[760px]:w-full max-[760px]:[&>*]:flex-1">
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
      setEcsServicesError(cause instanceof Error ? cause.message : translate('portForward.error.ecsServicesLoadFailed'));
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
      setEcsServicesError(cause instanceof Error ? cause.message : translate('portForward.error.ecsServiceDetailsLoadFailed'));
    } finally {
      setEcsServiceDetailsLoading(false);
    }
  }

  function openCreate(tab: ForwardTab = activeTab) {
    setActiveTab(tab);
    setEditingRuleId(null);
    setEditingDnsOverrideId(null);
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
      setDiscoveryError(cause instanceof Error ? cause.message : translate('portForward.error.containersLoadFailed'));
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
      setDiscoveryError(cause instanceof Error ? cause.message : translate('portForward.error.containerDetailsLoadFailed'));
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
        setError(translate('portForward.error.hostnameRequired'));
        return;
      }
      if (isLinkedDnsOverrideDraft(dnsDraft)) {
        if (!dnsDraft.portForwardRuleId) {
          setError(translate('portForward.error.ruleRequired'));
          return;
        }
      } else if (!dnsDraft.address.trim()) {
        setError(translate('portForward.error.ipRequired'));
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
        setError(cause instanceof Error ? cause.message : translate('portForward.error.dnsSaveFailed'));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (!draft.label.trim()) {
      setError(translate('portForward.error.nameRequired'));
      return;
    }
    if (!draft.hostId) {
      setError(translate('portForward.error.hostRequired'));
      return;
    }

    if (isEcsTaskPortForwardDraft(draft)) {
      if (draft.bindPort < 0) {
        setError(translate('portForward.error.localPortInvalid'));
        return;
      }
      if (!draft.serviceName.trim()) {
        setError(translate('portForward.error.serviceRequired'));
        return;
      }
      if (!draft.containerName.trim()) {
        setError(translate('portForward.error.containerRequired'));
        return;
      }
      if (!draft.targetPort || draft.targetPort <= 0) {
        setError(translate('portForward.error.targetPortRequired'));
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
        setError(cause instanceof Error ? cause.message : translate('portForward.error.ruleSaveFailed'));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (isContainerPortForwardDraft(draft)) {
      if (draft.bindPort < 0) {
        setError(translate('portForward.error.localPortInvalid'));
        return;
      }
      if (!draft.containerId) {
        setError(translate('portForward.error.containerRequired'));
        return;
      }
      if (!draft.networkName) {
        setError(translate('portForward.error.containerNetworkRequired'));
        return;
      }
      if (!draft.targetPort || draft.targetPort <= 0) {
        setError(translate('portForward.error.targetPortRequired'));
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
        setError(cause instanceof Error ? cause.message : translate('portForward.error.ruleSaveFailed'));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (draft.bindPort <= 0) {
      setError(translate('portForward.error.localPortInvalid'));
      return;
    }

    if (isAwsSsmPortForwardDraft(draft)) {
      if (!isLoopbackBindAddress(draft.bindAddress)) {
        setError(translate('portForward.error.ssmLoopbackRequired'));
        return;
      }
      if (!draft.targetPort || draft.targetPort <= 0) {
        setError(translate('portForward.error.targetPortInvalid'));
        return;
      }
      if (draft.targetKind === 'remote-host' && !draft.remoteHost?.trim()) {
        setError(translate('portForward.error.remoteHostRequired'));
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
        setError(cause instanceof Error ? cause.message : translate('portForward.error.ruleSaveFailed'));
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    if (draft.mode !== 'dynamic' && (!draft.targetHost?.trim() || !draft.targetPort || draft.targetPort <= 0)) {
      setError(translate('portForward.error.targetHostPortInvalid'));
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
      setError(cause instanceof Error ? cause.message : translate('portForward.error.ruleSaveFailed'));
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
      setIsContainerPickerOpen(false);
    }
  }, [isModalOpen]);

  useEffect(() => {
    if (!isModalOpen || !isContainerPickerOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (containerPickerRef.current?.contains(target)) {
        return;
      }
      setIsContainerPickerOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') {
        return;
      }
      setIsContainerPickerOpen(false);
    }

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isContainerPickerOpen, isModalOpen]);

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
            ? translate('portForward.error.dnsEnableFailed')
            : translate('portForward.error.dnsDisableFailed'),
        ),
      );
    } finally {
      setPendingDnsToggleId((current) =>
        current === overrideId ? null : current,
      );
    }
  }

  return (
    <>
      {connectingRule ? (
        <ConnectionProgressModal
          connectionKey={connectingRule.id}
          host={connectingHost}
          title={connectingRule.label || translate('portForwarding.title')}
          onClose={() => dismissConnectionView(connectingRule.id)}
        />
      ) : null}
    <div className="space-y-6">
      {/* 상단 브레드크럼(← Hosts · Port Forwarding)에 이미 제목이 있어 흰색 헤더 카드는 생략.
          생성 버튼은 아래 탭 행 오른쪽으로 옮긴다. */}
      {interactiveAuth ? (
        <InteractiveAuthCard
          auth={interactiveAuth}
          // 어느 포워딩이 묻는지 제목에서 말한다. 규칙이 여러 개 떠 있을 때 "Container tunnel" 처럼
          // 무관한 문구를 보여주면 어느 것을 위한 코드인지 알 수 없다.
          title={resolveForwardAuthTitle(translate, rules, hosts, interactiveAuth)}
          onRespond={onRespondInteractiveAuth}
          onReopenUrl={onReopenInteractiveAuthUrl}
          onCancel={() => {
            // 규칙을 멈추면 진행 중인 dial·핸드셰이크와 사람 대기가 함께 끊긴다(코어의 선-중단).
            void onStop(interactiveAuth.ruleId);
            onClearInteractiveAuth(interactiveAuth.challengeId);
          }}
        />
      ) : null}

      {!isModalOpen && discoveryInteractiveAuth ? (
        <InteractiveAuthCard
          auth={discoveryInteractiveAuth}
          title={translate('portForward.waiting.containerRuntime')}
          onRespond={onRespondInteractiveAuth}
          onReopenUrl={onReopenInteractiveAuthUrl}
          // 이 카드의 challengeId 만 지운다. 인자를 빼면(onCancel 은 인자 없이 불린다)
          // 다른 연결이 기다리는 카드까지 함께 사라지고, 그쪽은 답을 받지 못해 시간 초과로 죽는다.
          onCancel={() => onClearInteractiveAuth(discoveryInteractiveAuth.challengeId)}
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-4">
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
        <Button type="button" variant="primary" onClick={() => openCreate(activeTab)}>
          {createButtonLabel(activeTab)}
        </Button>
      </div>

      <PanelSection>
        {activeTab === 'dns' && dnsToggleError ? (
          <NoticeCard tone="danger" role="alert">
            {dnsToggleError}
          </NoticeCard>
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
                <Card
                  key={override.id}
                  className="items-start max-[760px]:flex-col max-[760px]:items-stretch"
                >
                  <CardMain>
                    <CardTitleRow>
                      <strong>{override.hostname}</strong>
                      <Badge>{isStatic ? 'Static' : 'Linked'}</Badge>
                      <StatusBadge tone={getRuntimeStatusTone(isStatic ? (override.status === 'active' ? 'running' : 'stopped') : runtime?.status)}>
                        {isStatic ? (override.status === 'active' ? 'On' : 'Off') : statusLabel(runtime)}
                      </StatusBadge>
                    </CardTitleRow>
                    <CardMeta>
                      <span>Hosts file</span>
                      <span>{isStatic ? 'Static IP' : rule?.label ?? 'Linked rule missing'}</span>
                      <span>
                        {isStatic
                          ? override.address
                          : `${runtime?.bindAddress ?? rule?.bindAddress ?? '127.0.0.1'}:${runtime?.bindPort ?? rule?.bindPort ?? 0}`}
                      </span>
                    </CardMeta>
                    {!isStatic && runtime?.message ? <CardMessage>{runtime.message}</CardMessage> : null}
                  </CardMain>
                  <CardActions className="max-[760px]:w-full max-[760px]:[&>*]:flex-1">
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
              <section className="flex flex-col gap-[0.9rem]">
                <SectionLabel className="m-0">Running tunnels</SectionLabel>
                {visibleEcsEphemeralRuntimes.map(renderEcsEphemeralRuntimeCard)}
              </section>
            ) : null}

            {activeTab === 'container' &&
            visibleContainerEphemeralRuntimes.length > 0 ? (
              <section className="flex flex-col gap-[0.9rem]">
                <SectionLabel className="m-0">Running tunnels</SectionLabel>
                {visibleContainerEphemeralRuntimes.map(
                  renderContainerEphemeralRuntimeCard,
                )}
              </section>
            ) : null}

            {visibleRules.length > 0 ? (
              <section className="flex flex-col gap-[0.9rem]">
                {activeTab === 'ecs-task' || activeTab === 'container' ? (
                  <SectionLabel className="m-0">Saved rules</SectionLabel>
                ) : null}
                {visibleRules.map(renderRuleCard)}
              </section>
            ) : null}
          </>
        )}
      </PanelSection>

      {isModalOpen ? (
        <DialogBackdrop onDismiss={() => void closeModal()} dismissDisabled={isSubmitting}>
          <ModalShell
            size={isContainerPortForwardDraft(draft) ? 'lg' : 'md'}
            role="dialog"
            aria-modal="true"
            aria-labelledby="port-forward-title"
          >
            <ModalHeader>
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
                <CloseIcon />
              </IconButton>
            </ModalHeader>

            <ModalBody className="grid gap-4">
              {activeTab === 'dns' ? (
                <>
                  <FieldGroup label="Override type">
                    <select
                      value={dnsDraft.type}
                      onChange={(event) => setDnsDraftType(event.target.value === 'static' ? 'static' : 'linked')}
                      disabled={isSubmitting}
                    >
                      <option value="linked">Linked</option>
                      <option value="static">Static</option>
                    </select>
                  </FieldGroup>

                  <FieldGroup label="Hostname">
                    <input
                      value={dnsDraft.hostname}
                      onChange={(event) => setDnsDraft((current) => ({ ...current, hostname: event.target.value }))}
                      disabled={isSubmitting}
                    />
                  </FieldGroup>

                  {isLinkedDnsOverrideDraft(dnsDraft) ? (
                    <>
                      <FieldGroup label="Linked rule">
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
                      </FieldGroup>

                      <FieldGroup label="Loopback target">
                        <input value={selectedDnsRule ? `${selectedDnsRule.bindAddress}:${selectedDnsRule.bindPort}` : ''} disabled readOnly />
                      </FieldGroup>
                    </>
                  ) : (
                    <>
                      <FieldGroup label="IP Address">
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
                      </FieldGroup>
                    </>
                  )}

                  {error ? <p className="text-[0.9rem] text-[var(--danger-text)]">{error}</p> : null}
                </>
              ) : (
                <>
                  <FieldGroup label="Label">
                    <input value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} disabled={isSubmitting} />
                  </FieldGroup>

              {isContainerPortForwardDraft(draft) ? (
                <FieldGroup label="Host">
                  <SearchableSelect
                    ariaLabel="Host"
                    searchAriaLabel="Container forwarding host search"
                    placeholder="Select host"
                    searchPlaceholder={translate('portForward.form.hostSearchPlaceholder')}
                    value={draft.hostId}
                    options={containerHostOptions}
                    onChange={selectContainerForwardHost}
                    disabled={isSubmitting || discoveryLoading || discoveryDetailsLoading}
                  />
                </FieldGroup>
              ) : isSshPortForwardDraft(draft) ? (
                <FieldGroup label="Host">
                  <SearchableSelect
                    ariaLabel="Host"
                    searchAriaLabel="SSH forwarding host search"
                    placeholder="Select host"
                    searchPlaceholder={translate('portForward.form.hostSearchPlaceholder')}
                    value={draft.hostId}
                    options={sshHostOptions}
                    onChange={selectSshForwardHost}
                    disabled={isSubmitting}
                  />
                </FieldGroup>
              ) : isAwsSsmPortForwardDraft(draft) ? (
                <FieldGroup label="AWS EC2 Host">
                  <SearchableSelect
                    ariaLabel="AWS EC2 Host"
                    searchAriaLabel="AWS EC2 forwarding host search"
                    placeholder="Select host"
                    searchPlaceholder={translate('portForward.form.hostSearchPlaceholder')}
                    value={draft.hostId}
                    options={awsHostOptions}
                    onChange={selectAwsForwardHost}
                    disabled={isSubmitting}
                  />
                </FieldGroup>
              ) : (
                <FieldGroup label="AWS ECS Host">
                  <SearchableSelect
                    ariaLabel="AWS ECS Host"
                    searchAriaLabel="ECS task forwarding host search"
                    placeholder="Select host"
                    searchPlaceholder={translate('portForward.form.hostSearchPlaceholder')}
                    value={draft.hostId}
                    options={ecsHostOptions}
                    onChange={selectEcsForwardHost}
                    disabled={isSubmitting}
                  />
                </FieldGroup>
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
                      title={translate('portForward.waiting.containerLookup')}
                      onRespond={onRespondInteractiveAuth}
                      onReopenUrl={onReopenInteractiveAuthUrl}
                      // 이 카드의 challengeId 만 지운다(위 컨테이너 런타임 카드와 같은 이유).
                      onCancel={() => onClearInteractiveAuth(discoveryInteractiveAuth.challengeId)}
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
                        setIsContainerPickerOpen((current) => !current);
                      }}
                      selectedContent={
                        selectedContainerSummary ? (
                          <div className="flex min-w-0 items-center justify-between gap-[0.9rem]">
                            <div className="min-w-0 grid gap-[0.25rem]">
                              <strong className="text-[1rem] text-[var(--text)]">
                                {selectedContainerSummary.name}
                              </strong>
                              <span className="truncate text-[0.82rem] text-[var(--text-soft)]">
                                {shortenContainerImage(selectedContainerSummary.image)}
                              </span>
                            </div>
                            <StatusBadge
                              tone={getDiscoveryContainerStatusPresentation(selectedContainerSummary.status).tone}
                              className="shrink-0"
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
                            className={cn(
                              'flex w-full items-center justify-between gap-[0.9rem] rounded-[12px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--dialog-surface-muted)_88%,transparent_12%)] px-[0.9rem] py-[0.9rem] text-left transition-[border-color,background,transform] duration-150 hover:border-[color-mix(in_srgb,var(--accent-strong)_30%,var(--border))] hover:bg-[color-mix(in_srgb,var(--dialog-surface)_84%,var(--accent-strong)_16%)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--accent-strong)_45%,white_55%)] focus-visible:outline-offset-2',
                              draft.containerId === container.id &&
                                'border-[color-mix(in_srgb,var(--accent-strong)_38%,var(--border))] bg-[color-mix(in_srgb,var(--dialog-surface)_76%,var(--accent-strong)_24%)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--accent-strong)_18%,transparent_82%)]',
                            )}
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
                            <div className="min-w-0 grid gap-[0.25rem]">
                              <strong className="text-[1rem] text-[var(--text)]">
                                {container.name}
                              </strong>
                              <span className="truncate text-[0.82rem] text-[var(--text-soft)]">
                                {shortenContainerImage(container.image)}
                              </span>
                            </div>
                            <StatusBadge
                              tone={statusPresentation.tone}
                              className="shrink-0"
                            >
                              {statusPresentation.label}
                            </StatusBadge>
                          </button>
                        );
                      })}
                    </PickerField>
                  </div>

                  {availableNetworks.length > 1 ? (
                    <FieldGroup label="Network">
                      <div className="relative">
                        <SelectField
                          className="min-h-[5.5rem] rounded-[12px] bg-[var(--dialog-surface-muted)] px-[1.1rem] pr-11"
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
                              {network.ipAddress
                                ? translate('portForward.form.networkWithIp', {
                                    name: network.name,
                                    ip: network.ipAddress,
                                  })
                                : translate('portForward.form.networkPendingIp', {
                                    name: network.name,
                                  })}
                            </option>
                          ))}
                        </SelectField>
                        <ChevronDown
                          className="pointer-events-none absolute right-4 top-1/2 h-[0.9rem] w-[0.9rem] -translate-y-1/2 text-[var(--text-soft)]"
                          aria-hidden="true"
                        />
                      </div>
                    </FieldGroup>
                  ) : null}

                  <FieldGroup label="Container port">
                    <div className="relative">
                      <SelectField
                        className="min-h-[5.5rem] rounded-[12px] bg-[var(--dialog-surface-muted)] px-[1.1rem] pr-11"
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
                      </SelectField>
                      <ChevronDown
                        className="pointer-events-none absolute right-4 top-1/2 h-[0.9rem] w-[0.9rem] -translate-y-1/2 text-[var(--text-soft)]"
                        aria-hidden="true"
                      />
                    </div>
                  </FieldGroup>

                  <FieldGroup label="Local port">
                    <div className="grid gap-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isAutoLocalPort}
                        aria-label="Auto (random)"
                        className={cn(
                          'flex w-full items-center gap-[0.9rem] rounded-[12px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--dialog-surface-muted)_88%,transparent_12%)] px-4 py-[0.9rem] text-left text-[var(--text)] transition-[border-color,box-shadow,background] duration-150 hover:border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--accent-strong)_50%,white_50%)] focus-visible:outline-offset-2',
                          isAutoLocalPort &&
                            'border-[color-mix(in_srgb,var(--accent-strong)_32%,var(--border))] bg-[color-mix(in_srgb,var(--accent-strong)_11%,var(--dialog-surface-muted)_89%)]',
                        )}
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
                        <span
                          className={cn(
                            'relative h-[1.8rem] w-12 shrink-0 rounded-full bg-[color-mix(in_srgb,var(--text-soft)_22%,transparent_78%)] transition-colors duration-150',
                            isAutoLocalPort &&
                              'bg-[color-mix(in_srgb,var(--accent-strong)_72%,transparent_28%)]',
                          )}
                          aria-hidden="true"
                        >
                          <span
                            className={cn(
                              'absolute left-[0.18rem] top-[0.18rem] h-[1.44rem] w-[1.44rem] rounded-full bg-white shadow-[0_6px_14px_rgba(16,26,40,0.2)] transition-transform duration-150',
                              isAutoLocalPort && 'translate-x-[1.18rem]',
                            )}
                          />
                        </span>
                        <span className="grid gap-[0.25rem]">
                          <strong className="text-[0.9rem] text-[var(--text)]">
                            Auto (random)
                          </strong>
                          <span className="text-[0.82rem] leading-[1.45] text-[var(--text-soft)]">
                            {translate('portForward.form.autoLocalPortHint')}
                          </span>
                        </span>
                      </button>
                      <Input
                        type="number"
                        className="bg-[var(--dialog-surface-muted)]"
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
                        placeholder={isAutoLocalPort ? translate('portForward.form.autoLocalPortPlaceholder') : '9000'}
                      />
                    </div>
                  </FieldGroup>

                  {discoveryError ? <p className="text-[0.9rem] text-[var(--danger-text)]">{discoveryError}</p> : null}
                  {discoveryDetailsLoading ? (
                    <NoticeCard>
                      <p>{translate('portForward.form.containerDetailsLoading')}</p>
                    </NoticeCard>
                  ) : null}
                  {discoveryDetails && eligiblePorts.length === 0 ? (
                    <EmptyState
                      title={translate('portForward.form.noTcpPortsTitle')}
                      description={translate('portForward.form.noTcpPortsDescription')}
                    />
                  ) : null}
                  {discoveryDetails && availableNetworks.length === 0 ? (
                    <EmptyState
                      title={translate('portForward.form.noNetworkIpTitle')}
                      description={translate('portForward.form.noNetworkIpDescription')}
                    />
                  ) : null}
                  {discoveryDetails && availableNetworks.length > 0 && eligibleNetworks.length === 0 ? (
                    <NoticeCard title={translate('portForward.form.networkIpHiddenTitle')}>
                      <p>{translate('portForward.form.networkIpHiddenHint')}</p>
                    </NoticeCard>
                  ) : null}
                </>
              ) : isSshPortForwardDraft(draft) ? (
                <>
                  <FieldGroup label="Mode">
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
                  </FieldGroup>

                  <FieldGroup label="Bind address">
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
                  </FieldGroup>
                </>
              ) : isEcsTaskPortForwardDraft(draft) ? (
                <>
                  <FieldGroup label="Service">
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
                  </FieldGroup>

                  <FieldGroup label="Container">
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
                  </FieldGroup>

                  <FieldGroup label="Container port">
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
                  </FieldGroup>

                  <FieldGroup label="Local port">
                    <div className="grid gap-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={isAutoEcsLocalPort}
                        aria-label="Auto (random)"
                        className={cn(
                          'flex w-full items-center gap-[0.9rem] rounded-[12px] border border-[var(--border)] bg-[color-mix(in_srgb,var(--dialog-surface-muted)_88%,transparent_12%)] px-4 py-[0.9rem] text-left text-[var(--text)] transition-[border-color,box-shadow,background] duration-150 hover:border-[color-mix(in_srgb,var(--accent-strong)_28%,var(--border))] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[color-mix(in_srgb,var(--accent-strong)_50%,white_50%)] focus-visible:outline-offset-2',
                          isAutoEcsLocalPort &&
                            'border-[color-mix(in_srgb,var(--accent-strong)_32%,var(--border))] bg-[color-mix(in_srgb,var(--accent-strong)_11%,var(--dialog-surface-muted)_89%)]',
                        )}
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
                        <span
                          className={cn(
                            'relative h-[1.8rem] w-12 shrink-0 rounded-full bg-[color-mix(in_srgb,var(--text-soft)_22%,transparent_78%)] transition-colors duration-150',
                            isAutoEcsLocalPort &&
                              'bg-[color-mix(in_srgb,var(--accent-strong)_72%,transparent_28%)]',
                          )}
                          aria-hidden="true"
                        >
                          <span
                            className={cn(
                              'absolute left-[0.18rem] top-[0.18rem] h-[1.44rem] w-[1.44rem] rounded-full bg-white shadow-[0_6px_14px_rgba(16,26,40,0.2)] transition-transform duration-150',
                              isAutoEcsLocalPort && 'translate-x-[1.18rem]',
                            )}
                          />
                        </span>
                        <span className="grid gap-[0.25rem]">
                          <strong className="text-[0.9rem] text-[var(--text)]">
                            Auto (random)
                          </strong>
                          <span className="text-[0.82rem] leading-[1.45] text-[var(--text-soft)]">
                            {translate('portForward.form.autoLocalPortHint')}
                          </span>
                        </span>
                      </button>
                      <Input
                        type="number"
                        className="bg-[var(--dialog-surface-muted)]"
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
                        placeholder={isAutoEcsLocalPort ? translate('portForward.form.autoLocalPortPlaceholder') : '9000'}
                      />
                    </div>
                  </FieldGroup>

                  {selectedEcsHost ? (
                    <NoticeCard title={selectedEcsHost.awsEcsClusterName}>
                      <p>{selectedEcsHost.awsProfileName} / {selectedEcsHost.awsRegion}</p>
                    </NoticeCard>
                  ) : null}
                  {ecsServicesError ? <p className="text-[0.9rem] text-[var(--danger-text)]">{ecsServicesError}</p> : null}
                  {ecsServicesLoading ? <NoticeCard><p>{translate('portForward.form.ecsServicesLoading')}</p></NoticeCard> : null}
                  {ecsServiceDetailsLoading ? <NoticeCard><p>{translate('portForward.form.ecsServiceDetailsLoading')}</p></NoticeCard> : null}
                  {!ecsServicesLoading && draft.hostId && ecsServices.length === 0 && !ecsServicesError ? (
                    <EmptyState
                      title={translate('portForward.form.noEcsServicesTitle')}
                      description={translate('portForward.form.noEcsServicesDescription')}
                    />
                  ) : null}
                  {!ecsServiceDetailsLoading && draft.serviceName && ecsServiceDetails && ecsContainerOptions.length === 0 ? (
                    <EmptyState
                      title={translate('portForward.form.noEcsContainersTitle')}
                      description={translate('portForward.form.noEcsContainersDescription')}
                    />
                  ) : null}
                  {!ecsServiceDetailsLoading && draft.containerName && ecsPortOptions.length === 0 ? (
                    <EmptyState
                      title={translate('portForward.form.noTcpPortsTitle')}
                      description={translate('portForward.form.noTcpPortsDescription')}
                    />
                  ) : null}
                </>
              ) : (
                <>
                  <FieldGroup label="Target kind">
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
                  </FieldGroup>

                  <FieldGroup label="Local address">
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
                  </FieldGroup>
                </>
              )}

              {!isContainerPortForwardDraft(draft) && !isEcsTaskPortForwardDraft(draft) ? (
                <FieldGroup label={isAwsSsmPortForwardDraft(draft) ? 'Local port' : 'Bind port'}>
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
                </FieldGroup>
              ) : null}

              {isSshPortForwardDraft(draft) && draft.mode !== 'dynamic' ? (
                <>
                  <FieldGroup label="Target host">
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
                  </FieldGroup>

                  <FieldGroup label="Target port">
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
                  </FieldGroup>
                </>
              ) : null}

              {isAwsSsmPortForwardDraft(draft) ? (
                <>
                  {shouldShowAwsRemoteHostField(draft) ? (
                    <FieldGroup label="Remote host">
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
                    </FieldGroup>
                  ) : null}

                  <FieldGroup label="Target port">
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
                  </FieldGroup>
                </>
              ) : null}

              {error ? <p className="text-[0.9rem] text-[var(--danger-text)]">{error}</p> : null}
                </>
              )}
            </ModalBody>

            <ModalFooter>
              <Button type="button" variant="secondary" onClick={() => void closeModal()} disabled={isSubmitting}>
                {translate('common.cancel')}
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
                {translate('common.save')}
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
    </>
  );
}
