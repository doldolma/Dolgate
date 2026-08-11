import { useEffect, useMemo, useRef, useState } from 'react';
import {
  isAwsEc2WindowsPlatform,
  type AwsEc2InstanceSummary,
  type AwsEcsClusterListItem,
  type AwsHostSshInspectionResult,
  type AwsProfileStatus,
  type AwsProfileSummary,
  type AwsWindowsPasswordFailure,
  type HostDraft,
  type HostSecretInput,
} from '@shared';
import { useAwsImportController } from '../controllers/useImportControllers';
import { DialogBackdrop } from './DialogBackdrop';
import { AwsExternalProfileImportDialog } from './AwsExternalProfileImportDialog';
import { AwsProfileCreateWizard } from './AwsProfileCreateWizard';
import {
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
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  NoticeCard,
  PanelSection,
  SectionLabel,
  StatusBadge,
  TabButton,
  Tabs,
} from '../ui';
import { useTranslation } from 'react-i18next';
import { t } from "../i18n";

type AwsImportMode = 'ec2' | 'ecs';

interface AwsImportDialogProps {
  open: boolean;
  currentGroupPath: string | null;
  onClose: () => void;
  onImport: (draft: HostDraft, secrets?: HostSecretInput) => Promise<void>;
}

function getSsmAvailabilityBadgeLabel(
  availability: AwsEc2InstanceSummary['ssmAvailability'],
): string {
  switch (availability) {
    case 'ready':
      return 'SSM Ready';
    case 'unavailable':
      return 'SSM Unavailable';
    case 'unknown':
    default:
      return 'SSM Unknown';
  }
}

function getSsmAvailabilityBadgeTone(
  availability: AwsEc2InstanceSummary['ssmAvailability'],
): 'running' | 'stopped' | 'neutral' {
  switch (availability) {
    case 'ready':
      return 'running';
    case 'unavailable':
      return 'stopped';
    case 'unknown':
    default:
      return 'neutral';
  }
}

function getSsmAvailabilityReason(instance: AwsEc2InstanceSummary): string | null {
  const trimmed = instance.ssmAvailabilityReason?.trim();
  if (trimmed) {
    return trimmed;
  }
  if (instance.ssmAvailability === 'unavailable') {
    return t('aws.ssm.notManaged');
  }
  if (instance.ssmAvailability === 'unknown') {
    return t('aws.ssm.statusUnknown');
  }
  return null;
}

/**
 * Windows 인스턴스는 SSH 검사를 건너뛰고 바로 등록한다.
 *
 * 검사는 SSH 사용자명·포트를 찾는 단계인데(AWS-RunShellScript, Linux 전용), Windows 는 애초에
 * SSH 로 붙지 않는다 — SSM 셸이 열어 주는 PowerShell 로 연결하고 그 경로엔 사용자명이 필요 없다.
 */
function isWindowsEc2Instance(instance: AwsEc2InstanceSummary): boolean {
  return isAwsEc2WindowsPlatform(instance.platform);
}

function canAddEc2Instance(instance: AwsEc2InstanceSummary): boolean {
  return instance.ssmAvailability === 'ready';
}

function getEc2ActionButtonLabel(instance: AwsEc2InstanceSummary): string {
  if (instance.ssmAvailability === 'unavailable') {
    return t('awsImport.badge.ssmUnavailable');
  }
  if (instance.ssmAvailability === 'unknown') {
    return t('awsImport.badge.blocked');
  }
  if (isWindowsEc2Instance(instance)) {
    return t('awsImport.badge.addWindows');
  }
  return t('awsImport.badge.inspect');
}

function resolveSelectedProfileName(
  profiles: AwsProfileSummary[],
  preferredProfile?: string | null,
): string {
  const preferred = preferredProfile?.trim() ?? '';
  if (preferred && profiles.some((profile) => profile.name === preferred)) {
    return preferred;
  }
  return profiles[0]?.name ?? '';
}

export function shouldShowAwsProfileAuthError(profileStatus: AwsProfileStatus | null, isLoadingStatus: boolean): boolean {
  return Boolean(profileStatus && !isLoadingStatus && !profileStatus.isAuthenticated);
}

export function shouldDisableAwsProfileSelect(input: {
  isLoadingProfiles: boolean;
  isLoadingStatus: boolean;
  isLoadingRegions: boolean;
  isLoadingInstances: boolean;
  isLoggingIn: boolean;
  profileCount: number;
}): boolean {
  return (
    input.isLoadingProfiles ||
    input.isLoadingStatus ||
    input.isLoadingRegions ||
    input.isLoadingInstances ||
    input.isLoggingIn ||
    input.profileCount === 0
  );
}

export function shouldDisableAwsRegionSelect(input: {
  isLoadingStatus: boolean;
  isLoadingRegions: boolean;
  isLoadingInstances: boolean;
  isLoggingIn: boolean;
  regionCount: number;
}): boolean {
  return input.isLoadingStatus || input.isLoadingRegions || input.isLoadingInstances || input.isLoggingIn || input.regionCount === 0;
}

function normalizeAwsSshPortInput(value: string): string {
  return value.replace(/[^\d]/g, '').slice(0, 5);
}

function toAwsSshPortValue(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(t('awsImport.error.portRange'));
  }
  return parsed;
}

export function AwsImportDialog({ open, currentGroupPath, onClose, onImport }: AwsImportDialogProps) {
  const { t: translate } = useTranslation();
  const {
    createAwsProfile,
    getSyncStatus,
    getExternalAwsProfileDetails,
    getAwsProfileStatus,
    importExternalAwsProfiles,
    inspectAwsHostSshMetadata,
    getAwsWindowsPassword,
    pickPrivateKeyFile,
    listExternalAwsProfiles,
    listAwsEc2Instances,
    listAwsEcsClusters,
    listAwsProfiles,
    listAwsRegions,
    loginAwsProfile,
    prepareAwsSsoProfile,
  } = useAwsImportController();
  const [importMode, setImportMode] = useState<AwsImportMode>('ec2');
  const [profiles, setProfiles] = useState<AwsProfileSummary[]>([]);
  const [selectedProfile, setSelectedProfile] = useState('');
  const [profileStatus, setProfileStatus] = useState<AwsProfileStatus | null>(null);
  const [regions, setRegions] = useState<string[]>([]);
  const [selectedRegion, setSelectedRegion] = useState('');
  const [instances, setInstances] = useState<AwsEc2InstanceSummary[]>([]);
  const [ecsClusters, setEcsClusters] = useState<AwsEcsClusterListItem[]>([]);
  const [isLoadingProfiles, setIsLoadingProfiles] = useState(false);
  const [isLoadingStatus, setIsLoadingStatus] = useState(false);
  const [isLoadingRegions, setIsLoadingRegions] = useState(false);
  const [isLoadingInstances, setIsLoadingInstances] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isCreateProfileOpen, setIsCreateProfileOpen] = useState(false);
  const [isExternalImportOpen, setIsExternalImportOpen] = useState(false);
  const [externalImportSummary, setExternalImportSummary] = useState<string | null>(null);
  const [awsProfilesServerSupport, setAwsProfilesServerSupport] = useState<'unknown' | 'supported' | 'unsupported'>('unknown');
  const [error, setError] = useState<string | null>(null);
  const [inspectionTarget, setInspectionTarget] = useState<AwsEc2InstanceSummary | null>(null);
  const [inspectionStatus, setInspectionStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [inspectionUsernameCandidates, setInspectionUsernameCandidates] = useState<string[]>([]);
  const [inspectionUsername, setInspectionUsername] = useState('');
  const [inspectionPort, setInspectionPort] = useState('');

  const selectedProfileSummary = useMemo(
    () => profiles.find((profile) => profile.name === selectedProfile) ?? null,
    [profiles, selectedProfile],
  );

  const resetCreateProfileForm = () => {
    setIsCreateProfileOpen(false);
  };
  const [isRegistering, setIsRegistering] = useState(false);
  const inspectionRequestIdRef = useRef(0);
  const usernameDirtyRef = useRef(false);
  const portDirtyRef = useRef(false);
  const usernameValueRef = useRef('');
  const portValueRef = useRef('');

  useEffect(() => {
    if (!open) {
      return;
    }
    void getSyncStatus()
      .then((status) => {
        setAwsProfilesServerSupport(status.awsProfilesServerSupport ?? 'unknown');
      })
      .catch(() => undefined);
  }, [getSyncStatus, open]);

  const resetInspection = () => {
    inspectionRequestIdRef.current += 1;
    usernameDirtyRef.current = false;
    portDirtyRef.current = false;
    usernameValueRef.current = '';
    portValueRef.current = '';
    setInspectionTarget(null);
    setInspectionStatus('idle');
    setInspectionError(null);
    setInspectionUsernameCandidates([]);
    setInspectionUsername('');
    setInspectionPort('');
    setIsRegistering(false);
  };

  const applyInspectionResult = (result: AwsHostSshInspectionResult) => {
    setInspectionStatus(result.status);
    setInspectionError(result.errorMessage);
    setInspectionUsernameCandidates(result.usernameCandidates);

    if (!usernameDirtyRef.current || !usernameValueRef.current.trim()) {
      const nextUsername = result.recommendedUsername ?? '';
      usernameValueRef.current = nextUsername;
      setInspectionUsername(nextUsername);
    }

    if (!portDirtyRef.current || !portValueRef.current.trim()) {
      const nextPort =
        result.sshPort && Number.isInteger(result.sshPort)
          ? String(result.sshPort)
          : '';
      portValueRef.current = nextPort;
      setInspectionPort(nextPort);
    }
  };

  /** Windows 는 검사할 게 없으므로 등록 화면만 띄운다 — SSH 사용자명·포트는 비운 채로 남는다. */
  const beginWindowsRegistration = (instance: AwsEc2InstanceSummary) => {
    inspectionRequestIdRef.current += 1;
    usernameDirtyRef.current = false;
    portDirtyRef.current = false;
    usernameValueRef.current = '';
    portValueRef.current = '';
    setInspectionUsername('');
    setInspectionPort('');
    setInspectionUsernameCandidates([]);
    setInspectionTarget(instance);
    setInspectionStatus('idle');
    setInspectionError(null);
  };

  /** RDP 로 추가하는 중인 인스턴스. Linux 의 검사 단계와 같은 자리다. */
  const [rdpTarget, setRdpTarget] = useState<AwsEc2InstanceSummary | null>(null);
  const [rdpPrivateKey, setRdpPrivateKey] = useState('');
  const [rdpPassword, setRdpPassword] = useState('');
  const [rdpFetchStatus, setRdpFetchStatus] = useState<'idle' | 'loading' | 'done'>('idle');
  const [rdpFetchFailure, setRdpFetchFailure] = useState<AwsWindowsPasswordFailure | null>(null);
  const [rdpError, setRdpError] = useState<string | null>(null);

  const resetRdpRegistration = () => {
    setRdpTarget(null);
    setRdpPrivateKey('');
    setRdpPassword('');
    setRdpFetchStatus('idle');
    setRdpFetchFailure(null);
    setRdpError(null);
  };

  /**
   * 초기 관리자 비밀번호를 가져온다.
   *
   * 개인키는 메인 프로세스로 한 번 건너가 그 자리에서 복호화되고 어디에도 남지 않는다. 결과가 비어
   * 오는 경우가 흔해서(비밀번호를 바꿨거나 도메인 조인, 부팅 직후) 이유를 받아 화면에 그대로
   * 안내하고, 사용자는 직접 입력으로 넘어갈 수 있다.
   */
  const fetchWindowsPassword = async () => {
    if (!rdpTarget) {
      return;
    }
    setRdpError(null);
    setRdpFetchFailure(null);
    setRdpFetchStatus('loading');
    try {
      const result = await getAwsWindowsPassword({
        profileName: selectedProfile,
        region: selectedRegion,
        instanceId: rdpTarget.instanceId,
        privateKeyPem: rdpPrivateKey,
      });
      if (result.password) {
        setRdpPassword(result.password);
        setRdpFetchStatus('done');
        return;
      }
      setRdpFetchStatus('idle');
      setRdpFetchFailure(result.reason ?? 'not-available');
    } catch (error) {
      setRdpFetchStatus('idle');
      setRdpError(
        error instanceof Error
          ? error.message
          : translate('awsImport.rdp.fetchFailed'),
      );
    }
  };

  /**
   * Windows 인스턴스를 RDP 호스트 + 자격증명으로 등록한다.
   *
   * 검사(inspect)를 거치지 않는다 — 그 단계는 SSH 사용자명·포트를 찾는 것이고 RDP 에는 쓸 데가 없다.
   * 대신 비밀번호가 있어야 등록된다(비밀번호 없이 만들면 붙을 수 없는 호스트가 남는다).
   *
   * `hostname` 은 사설 IP 를 그대로 쓴다. 실제 접속은 SSM 포워드가 만든 로컬 주소로 가지만,
   * TLS 서버 이름과 인증서 지문 핀의 키는 이 이름이다.
   */
  const registerRdpInstance = async () => {
    const instance = rdpTarget;
    const password = rdpPassword.trim();
    if (!instance || !password) {
      return;
    }
    try {
      setRdpError(null);
      setIsRegistering(true);
      await onImport(
        {
          kind: 'rdp',
          label: instance.name || instance.instanceId,
          groupName: currentGroupPath ?? '',
          terminalThemeId: null,
          hostname: instance.privateIp?.trim() || instance.instanceId,
          port: 3389,
          awsSsm: {
            profileName: selectedProfile,
            region: selectedRegion,
            instanceId: instance.instanceId,
          },
        },
        // 자격증명으로 저장한다 — 호스트 레코드에는 계정이 실리지 않는다. EC2 Windows 의 기본
        // 관리자 계정은 Administrator 이고, 도메인은 이 경로에서 쓰지 않는다.
        { kind: 'rdp', username: 'Administrator', password },
      );
      resetRdpRegistration();
      onClose();
    } catch (submitError) {
      setRdpError(
        submitError instanceof Error
          ? submitError.message
          : translate('awsImport.error.hostRegisterFailed'),
      );
    } finally {
      setIsRegistering(false);
    }
  };

  const inspectInstance = async (
    instance: AwsEc2InstanceSummary,
    preserveEdits: boolean,
  ) => {
    const requestId = inspectionRequestIdRef.current + 1;
    inspectionRequestIdRef.current = requestId;

    if (!preserveEdits) {
      usernameDirtyRef.current = false;
      portDirtyRef.current = false;
      usernameValueRef.current = '';
      portValueRef.current = '';
      setInspectionUsername('');
      setInspectionPort('');
      setInspectionUsernameCandidates([]);
    }

    setInspectionTarget(instance);
    setInspectionStatus('loading');
    setInspectionError(null);

    let result: AwsHostSshInspectionResult;
    try {
      result = await inspectAwsHostSshMetadata({
        profileName: selectedProfile,
        region: selectedRegion,
        instanceId: instance.instanceId,
        availabilityZone: instance.availabilityZone ?? null,
      });
    } catch (inspectError) {
      result = {
        sshPort: 22,
        recommendedUsername: null,
        usernameCandidates: [],
        status: 'error',
        errorMessage:
          inspectError instanceof Error
            ? inspectError.message
            : translate('awsImport.error.sshAutoFailed'),
      };
    }

    if (inspectionRequestIdRef.current !== requestId) {
      return;
    }

    applyInspectionResult(result);
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    setImportMode('ec2');
    setProfiles([]);
    setSelectedProfile('');
    setProfileStatus(null);
    setRegions([]);
    setSelectedRegion('');
    setInstances([]);
    setEcsClusters([]);
    setExternalImportSummary(null);
    setError(null);
    resetCreateProfileForm();
    resetInspection();
    setIsLoadingProfiles(true);

    void listAwsProfiles()
      .then((items) => {
        setProfiles(items);
        setSelectedProfile(resolveSelectedProfileName(items));
      })
      .catch((loadError) => {
        setError(loadError instanceof Error ? loadError.message : translate('awsImport.error.profileListFailed'));
      })
      .finally(() => {
        setIsLoadingProfiles(false);
      });
  }, [open]);

  useEffect(() => {
    if (!open || !selectedProfile) {
      setProfileStatus(null);
      setRegions([]);
      setSelectedRegion('');
      setInstances([]);
      setEcsClusters([]);
      return;
    }

    let cancelled = false;
    setIsLoadingStatus(true);
    setProfileStatus(null);
    setRegions([]);
    setSelectedRegion('');
    setInstances([]);
    setEcsClusters([]);
    setError(null);

    void getAwsProfileStatus(selectedProfile)
      .then((status) => {
        if (cancelled) {
          return;
        }
        setProfileStatus(status);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : translate('awsImport.error.profileStatusFailed'));
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingStatus(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, selectedProfile]);

  useEffect(() => {
    if (!open || !selectedProfile || !profileStatus?.isAuthenticated) {
      setIsLoadingRegions(false);
      setRegions([]);
      setSelectedRegion('');
      setInstances([]);
      setEcsClusters([]);
      return;
    }

    let cancelled = false;
    setIsLoadingRegions(true);
    setError(null);

    void listAwsRegions(selectedProfile)
      .then((nextRegions) => {
        if (cancelled) {
          return;
        }
        setRegions(nextRegions);
        setSelectedRegion((current) => {
          if (current && nextRegions.includes(current)) {
            return current;
          }
          const configuredRegion = profileStatus?.configuredRegion?.trim() ?? '';
          if (configuredRegion && nextRegions.includes(configuredRegion)) {
            return configuredRegion;
          }
          return '';
        });
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(loadError instanceof Error ? loadError.message : translate('awsImport.error.regionListFailed'));
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingRegions(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [open, profileStatus?.isAuthenticated, selectedProfile]);

  useEffect(() => {
    if (!open || !selectedProfile || !selectedRegion || !profileStatus?.isAuthenticated) {
      setIsLoadingInstances(false);
      setInstances([]);
      setEcsClusters([]);
      return;
    }

    let cancelled = false;
    setIsLoadingInstances(true);
    setError(null);

    const loadTargets =
      importMode === 'ecs'
        ? listAwsEcsClusters(selectedProfile, selectedRegion)
        : listAwsEc2Instances(selectedProfile, selectedRegion);

    void loadTargets
      .then((items) => {
        if (cancelled) {
          return;
        }
        if (importMode === 'ecs') {
          setEcsClusters(items as AwsEcsClusterListItem[]);
          setInstances([]);
          return;
        }
        setInstances(items as AwsEc2InstanceSummary[]);
        setEcsClusters([]);
      })
      .catch((loadError) => {
        if (cancelled) {
          return;
        }
        setError(
          loadError instanceof Error
            ? loadError.message
            : importMode === 'ecs'
              ? translate('awsImport.error.ecsClusterListFailed')
              : translate('awsImport.error.ec2ListFailed'),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingInstances(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [importMode, open, profileStatus?.isAuthenticated, selectedProfile, selectedRegion]);

  const handleCreateProfileSuccess = async (profileName: string) => {
    setError(null);
    const items = await listAwsProfiles();
    setProfiles(items);
    setSelectedProfile(resolveSelectedProfileName(items, profileName));
    resetCreateProfileForm();
  };

  const handleExternalImportSuccess = async (result: {
    importedProfileNames: string[]
    skippedProfileNames: string[]
  }) => {
    const parts: string[] = []
    if (result.importedProfileNames.length > 0) {
      parts.push(translate('awsProfiles.import.imported', { count: result.importedProfileNames.length }))
    }
    if (result.skippedProfileNames.length > 0) {
      parts.push(translate('awsProfiles.import.skipped', { count: result.skippedProfileNames.length }))
    }
    setExternalImportSummary(parts.length > 0 ? `${parts.join(', ')}.` : null)
    const items = await listAwsProfiles()
    setProfiles(items)
    setSelectedProfile(
      resolveSelectedProfileName(items, result.importedProfileNames[0] ?? selectedProfile),
    )
  };

  const unknownSsmAvailabilityReason = useMemo(
    () =>
      instances.find((instance) => instance.ssmAvailability === 'unknown')
        ?.ssmAvailabilityReason?.trim() ||
      translate('aws.ssm.statusUnknown'),
    [instances],
  );
  const shouldShowUnknownSsmNotice =
    importMode === 'ec2' &&
    !inspectionTarget &&
    instances.some((instance) => instance.ssmAvailability === 'unknown');
  const loadingMessage = inspectionTarget
    ? null
    : isLoadingProfiles
      ? translate('awsImport.loading.profiles')
      : isLoadingStatus
        ? translate('awsImport.loading.profileStatus')
        : isLoggingIn
          ? translate('awsImport.loading.browserLogin')
          : isLoadingRegions
            ? translate('awsImport.loading.regions')
            : isLoadingInstances
              ? importMode === 'ecs'
                ? translate('awsImport.loading.ecsClusters')
                : translate('awsImport.loading.ec2Instances')
              : null;
  const inspectionCandidateChips = useMemo(
    () =>
      [...new Set(inspectionUsernameCandidates.filter(Boolean))].filter(
        (candidate) => candidate.trim() !== inspectionUsername.trim(),
      ),
    [inspectionUsername, inspectionUsernameCandidates],
  );

  if (!open) {
    return null;
  }

  return (
    <>
      <DialogBackdrop
        onDismiss={onClose}
        dismissDisabled={isRegistering}
      >
        <ModalShell role="dialog" aria-modal="true" aria-labelledby="aws-import-title" size="xl">
          <ModalHeader>
            <div>
              <SectionLabel>AWS</SectionLabel>
              <h3 id="aws-import-title">Import via AWS SSM</h3>
            </div>
            <IconButton onClick={onClose} aria-label="Close AWS import dialog" disabled={isRegistering}>
              <CloseIcon />
            </IconButton>
          </ModalHeader>

        <ModalBody className="grid gap-4">
          <Tabs aria-label="AWS import mode" className="justify-start">
            <TabButton
              type="button"
              active={importMode === 'ec2'}
              onClick={() => {
                if (inspectionTarget || isRegistering) {
                  return;
                }
                setImportMode('ec2');
                resetInspection();
              }}
              disabled={Boolean(inspectionTarget) || isRegistering}
            >
              EC2 (SSM)
            </TabButton>
            <TabButton
              type="button"
              active={importMode === 'ecs'}
              onClick={() => {
                if (inspectionTarget || isRegistering) {
                  return;
                }
                setImportMode('ecs');
                resetInspection();
              }}
              disabled={Boolean(inspectionTarget) || isRegistering}
            >
              ECS
            </TabButton>
          </Tabs>

          <div className="grid gap-4 md:grid-cols-2">
            <FieldGroup label="Profile">
              <select
                value={selectedProfile}
                onChange={(event) => setSelectedProfile(event.target.value)}
                disabled={
                  shouldDisableAwsProfileSelect({
                    isLoadingProfiles,
                    isLoadingStatus,
                    isLoadingRegions,
                    isLoadingInstances,
                    isLoggingIn,
                    profileCount: profiles.length
                  }) || Boolean(inspectionTarget)
                }
              >
                {profiles.length === 0 ? <option value="">No profiles found</option> : null}
                {profiles.map((profile) => (
                  <option key={profile.name} value={profile.name}>
                    {profile.name}
                  </option>
                ))}
              </select>
            </FieldGroup>

            {profileStatus?.isAuthenticated ? (
              <FieldGroup label="Region">
                <select
                  value={selectedRegion}
                  onChange={(event) => setSelectedRegion(event.target.value)}
                  disabled={
                    shouldDisableAwsRegionSelect({
                      isLoadingStatus,
                      isLoadingRegions,
                      isLoadingInstances,
                      isLoggingIn,
                      regionCount: regions.length
                    }) || Boolean(inspectionTarget)
                  }
                >
                  {regions.length === 0 ? <option value="">No regions found</option> : null}
                  {regions.map((region) => (
                    <option key={region} value={region}>
                      {region}
                    </option>
                  ))}
                </select>
              </FieldGroup>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="secondary"
              disabled={Boolean(inspectionTarget) || isRegistering}
              onClick={() => {
                setIsExternalImportOpen(true)
              }}
            >
              {translate('awsImport.action.importFromCli')}
            </Button>
            <Button
              variant="secondary"
              disabled={Boolean(inspectionTarget) || isRegistering}
              onClick={() => {
                setIsCreateProfileOpen((current) => !current);
              }}
            >
              {translate(isCreateProfileOpen ? 'awsImport.action.closeCreateProfile' : 'awsImport.action.createProfile')}
            </Button>
          </div>

          {isCreateProfileOpen ? (
            <Card data-testid="aws-create-profile-form" className="items-stretch">
              <CardMain>
                <AwsProfileCreateWizard
                  testId="aws-create-profile-fields"
                  title={translate('awsImport.profile.wizardTitle')}
                  descriptions={[
                    translate('awsImport.profile.wizardDescription'),
                    ...(awsProfilesServerSupport === 'unsupported'
                      ? [translate('awsImport.profile.wizardSyncUnsupported')]
                      : []),
                  ]}
                  profiles={profiles}
                  createProfile={createAwsProfile}
                  prepareSsoProfile={prepareAwsSsoProfile}
                  onCancel={() => resetCreateProfileForm()}
                  onSuccess={(profileName) => handleCreateProfileSuccess(profileName)}
                />
              </CardMain>
            </Card>
          ) : null}

          {externalImportSummary ? (
            <NoticeCard tone="info">{externalImportSummary}</NoticeCard>
          ) : null}

          {awsProfilesServerSupport === 'unsupported' ? (
            <NoticeCard tone="warning">
              {translate('awsImport.profile.syncUnsupported')}
            </NoticeCard>
          ) : null}

          {loadingMessage ? <NoticeCard tone="info">{loadingMessage}</NoticeCard> : null}

          {shouldShowAwsProfileAuthError(profileStatus, isLoadingStatus) && profileStatus ? (
            <NoticeCard tone="danger" role="alert">
              {profileStatus.isSsoProfile
                ? translate('awsImport.profile.ssoLoginNeeded')
                : profileStatus.errorMessage || translate('awsImport.profile.credentialsNeeded')}
            </NoticeCard>
          ) : null}

          {shouldShowUnknownSsmNotice ? (
            <NoticeCard tone="warning" role="alert">
              {unknownSsmAvailabilityReason}
            </NoticeCard>
          ) : null}

          {profileStatus?.isSsoProfile && !profileStatus.isAuthenticated ? (
            <div className="flex flex-wrap items-center justify-end gap-3">
              <Button
                variant="primary"
                onClick={async () => {
                  if (!selectedProfile) {
                    return;
                  }
                  setIsLoggingIn(true);
                  setError(null);
                  try {
                    await loginAwsProfile(selectedProfile);
                    const status = await getAwsProfileStatus(selectedProfile);
                    setProfileStatus(status);
                  } catch (loginError) {
                    setError(loginError instanceof Error ? loginError.message : translate('awsImport.error.ssoLoginFailed'));
                  } finally {
                    setIsLoggingIn(false);
                  }
                }}
                disabled={isLoggingIn}
              >
                {translate(isLoggingIn ? 'awsImport.action.signingIn' : 'awsImport.action.signInBrowser')}
              </Button>
            </div>
          ) : null}

          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          {rdpTarget ? (
            <div className="grid min-h-0 gap-4" data-testid="aws-import-rdp">
              <Card>
                <CardMain>
                  <CardTitleRow>
                    <strong>{rdpTarget.name || rdpTarget.instanceId}</strong>
                    <StatusBadge tone="running">{rdpTarget.state || 'unknown'}</StatusBadge>
                  </CardTitleRow>
                  <CardMeta>
                    <span>{rdpTarget.instanceId}</span>
                    <span>{selectedRegion}</span>
                    <span>{rdpTarget.privateIp || 'No private IP'}</span>
                    {/* 어느 .pem 을 찾아야 하는지. 콘솔도 같은 자리에 보여 준다. */}
                    <span>{rdpTarget.keyName || translate('awsImport.rdp.noKeyPair')}</span>
                  </CardMeta>
                </CardMain>
              </Card>

              <NoticeCard tone="info" title={translate('awsImport.rdp.title')}>
                <p>{translate('awsImport.rdp.hint')}</p>
              </NoticeCard>

              <FieldGroup label={translate('awsImport.rdp.privateKeyLabel')}>
                <textarea
                  className="min-h-[7rem] font-mono text-[0.8rem]"
                  value={rdpPrivateKey}
                  onChange={(event) => setRdpPrivateKey(event.target.value)}
                  placeholder={translate('awsImport.rdp.privateKeyPlaceholder')}
                  disabled={rdpFetchStatus === 'loading' || isRegistering}
                  spellCheck={false}
                />
              </FieldGroup>

              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="secondary"
                  disabled={rdpFetchStatus === 'loading' || isRegistering}
                  onClick={async () => {
                    const picked = await pickPrivateKeyFile();
                    if (picked?.content) {
                      setRdpPrivateKey(picked.content);
                    }
                  }}
                >
                  {translate('awsImport.rdp.pickKey')}
                </Button>
                <Button
                  disabled={
                    !rdpPrivateKey.trim() || rdpFetchStatus === 'loading' || isRegistering
                  }
                  onClick={fetchWindowsPassword}
                >
                  {translate(
                    rdpFetchStatus === 'loading'
                      ? 'awsImport.rdp.fetching'
                      : 'awsImport.rdp.fetch',
                  )}
                </Button>
              </div>

              {rdpFetchFailure ? (
                <NoticeCard tone="warning" role="alert">
                  {translate(`awsImport.rdp.failure.${rdpFetchFailure}`)}
                </NoticeCard>
              ) : null}
              {rdpError ? (
                <NoticeCard tone="danger" role="alert">
                  {rdpError}
                </NoticeCard>
              ) : null}

              {/* 못 가져왔으면 직접 입력한다. 가져왔어도 고칠 수 있어야 한다 — 비밀번호를 바꾼 뒤라면
                  AWS 가 주는 값은 이미 옛 것이다. */}
              <FieldGroup label={translate('awsImport.rdp.passwordLabel')}>
                <input
                  type="password"
                  value={rdpPassword}
                  onChange={(event) => setRdpPassword(event.target.value)}
                  placeholder={translate('awsImport.rdp.passwordPlaceholder')}
                  disabled={isRegistering}
                />
              </FieldGroup>
            </div>
          ) : inspectionTarget ? (
            <div className="grid min-h-0 gap-4" data-testid="aws-import-inspection">
              <Card>
                <CardMain>
                  <CardTitleRow>
                    <strong>{inspectionTarget.name || inspectionTarget.instanceId}</strong>
                    <StatusBadge tone="running">{inspectionTarget.state || 'unknown'}</StatusBadge>
                  </CardTitleRow>
                  <CardMeta>
                    <span>{inspectionTarget.instanceId}</span>
                    <span>{selectedRegion}</span>
                    <span>{inspectionTarget.availabilityZone || 'AZ unavailable'}</span>
                    <span>{inspectionTarget.privateIp || 'No private IP'}</span>
                    <span>{inspectionTarget.platform || 'linux'}</span>
                  </CardMeta>
                </CardMain>
              </Card>

              {isWindowsEc2Instance(inspectionTarget) ? (
                <NoticeCard tone="info" title={translate('awsImport.inspect.windowsTitle')}>
                  <p>{translate('awsImport.inspect.windowsHint')}</p>
                </NoticeCard>
              ) : null}

              {!isWindowsEc2Instance(inspectionTarget) && inspectionStatus === 'loading' ? (
                <NoticeCard tone="info">
                  {translate('awsImport.inspect.inProgress')}
                </NoticeCard>
              ) : null}

              {!isWindowsEc2Instance(inspectionTarget) && inspectionStatus === 'ready' ? (
                <NoticeCard
                  title={translate('awsImport.inspect.doneTitle')}
                >
                  <p>{translate('awsImport.inspect.doneHint')}</p>
                </NoticeCard>
              ) : null}

              {!isWindowsEc2Instance(inspectionTarget) &&
              inspectionStatus === 'error' &&
              inspectionError ? (
                <NoticeCard tone="danger" role="alert">
                  {inspectionError}
                </NoticeCard>
              ) : null}

              {/* SSH 사용자명·포트는 SSH 경로에만 쓰인다 — Windows 는 그 경로로 안 가므로 뺀다. */}
              {isWindowsEc2Instance(inspectionTarget) ? null : (
              <>
              <div className="grid gap-4 md:grid-cols-2">
                <FieldGroup label="SSH Username">
                  <input
                    value={inspectionUsername}
                    onChange={(event) => {
                      usernameDirtyRef.current = true;
                      usernameValueRef.current = event.target.value;
                      setInspectionUsername(event.target.value);
                    }}
                    placeholder={translate('awsImport.inspect.usernamePlaceholder')}
                    disabled={inspectionStatus === 'loading' || isRegistering}
                  />
                </FieldGroup>

                <FieldGroup label="SSH Port">
                  <input
                    inputMode="numeric"
                    value={inspectionPort}
                    onChange={(event) => {
                      const nextValue = normalizeAwsSshPortInput(event.target.value);
                      portDirtyRef.current = true;
                      portValueRef.current = nextValue;
                      setInspectionPort(nextValue);
                    }}
                    placeholder={translate('awsImport.inspect.portPlaceholder')}
                    disabled={inspectionStatus === 'loading' || isRegistering}
                  />
                </FieldGroup>
              </div>

              {inspectionCandidateChips.length > 0 ? (
                <div className="flex flex-wrap gap-[0.55rem]">
                  {inspectionCandidateChips.map((candidate) => (
                    <Button
                      key={candidate}
                      variant="secondary"
                      className="px-[0.9rem]"
                      disabled={inspectionStatus === 'loading' || isRegistering}
                      onClick={() => {
                        usernameDirtyRef.current = true;
                        usernameValueRef.current = candidate;
                        setInspectionUsername(candidate);
                      }}
                    >
                      {candidate}
                    </Button>
                  ))}
                </div>
              ) : null}
              </>
              )}
            </div>
          ) : profileStatus?.isAuthenticated && selectedRegion && importMode === 'ecs' ? (
            <div className="mt-[0.9rem]" data-testid="aws-import-ecs-cluster-list">
              <PanelSection>
                {ecsClusters.length === 0 && !isLoadingInstances ? (
                  <EmptyState title={translate('awsImport.empty.noEcsClusters')} />
                ) : (
                  ecsClusters.map((cluster) => (
                    <Card key={cluster.clusterArn}>
                      <CardMain>
                        <CardTitleRow>
                          <strong>{cluster.clusterName}</strong>
                          <StatusBadge tone="running">
                            {cluster.status || 'UNKNOWN'}
                          </StatusBadge>
                        </CardTitleRow>
                        <CardMeta>
                          <span>{selectedProfile}</span>
                          <span>{selectedRegion}</span>
                          <span>Services {cluster.activeServicesCount}</span>
                          <span>Running {cluster.runningTasksCount}</span>
                          <span>Pending {cluster.pendingTasksCount}</span>
                        </CardMeta>
                      </CardMain>
                      <CardActions>
                        <Button
                          variant="primary"
                          disabled={isRegistering}
                          onClick={async () => {
                            setIsRegistering(true);
                            setError(null);
                            try {
                              await onImport({
                                kind: 'aws-ecs',
                                label: cluster.clusterName,
                                groupName: currentGroupPath ?? '',
                                terminalThemeId: null,
                                awsProfileId: selectedProfileSummary?.id ?? null,
                                awsProfileName: selectedProfile,
                                awsRegion: selectedRegion,
                                awsEcsClusterArn: cluster.clusterArn,
                                awsEcsClusterName: cluster.clusterName,
                              });
                              onClose();
                            } catch (submitError) {
                              setError(
                                submitError instanceof Error
                                  ? submitError.message
                                  : translate('awsImport.error.clusterRegisterFailed'),
                              );
                            } finally {
                              setIsRegistering(false);
                            }
                          }}
                        >
                          {translate(isRegistering ? 'awsImport.action.addingCluster' : 'awsImport.action.addCluster')}
                        </Button>
                      </CardActions>
                    </Card>
                  ))
                )}
              </PanelSection>
            </div>
          ) : profileStatus?.isAuthenticated && selectedRegion ? (
            <div className="mt-[0.9rem]" data-testid="aws-import-instance-list">
              <PanelSection>
                {instances.length === 0 && !isLoadingInstances ? (
                  <EmptyState title={translate('awsImport.empty.noEc2Instances')} />
                ) : (
                  instances.map((instance) => (
                    <Card key={instance.instanceId}>
                      <CardMain>
                        <CardTitleRow>
                          <strong>{instance.name || instance.instanceId}</strong>
                          <StatusBadge tone="running">{instance.state || 'unknown'}</StatusBadge>
                          <StatusBadge tone={getSsmAvailabilityBadgeTone(instance.ssmAvailability)}>
                            {getSsmAvailabilityBadgeLabel(instance.ssmAvailability)}
                          </StatusBadge>
                        </CardTitleRow>
                        <CardMeta>
                          <span>{instance.instanceId}</span>
                          <span>{selectedRegion}</span>
                          <span>{instance.availabilityZone || 'AZ unavailable'}</span>
                          <span>{instance.privateIp || 'No private IP'}</span>
                          <span>{instance.platform || 'linux'}</span>
                        </CardMeta>
                        {instance.ssmAvailability !== 'ready' ? (
                          <CardMessage>{getSsmAvailabilityReason(instance)}</CardMessage>
                        ) : null}
                      </CardMain>
                      <CardActions>
                        {/* Windows 는 셸(PowerShell)과 RDP 두 가지로 붙을 수 있다. 둘 다 SSM 을
                            거치므로 보안그룹을 열지 않아도 된다. */}
                        {isWindowsEc2Instance(instance) ? (
                          <Button
                            disabled={!canAddEc2Instance(instance) || isRegistering}
                            onClick={() => {
                              if (!canAddEc2Instance(instance)) {
                                return;
                              }
                              // Linux 의 "SSH 정보 확인" 과 같은 자리다 — 바로 등록하지 않고 비밀번호를
                              // 가져오는 단계로 넘어간다. 비밀번호 없이 만든 호스트는 붙을 수 없다.
                              resetInspection();
                              resetRdpRegistration();
                              setRdpTarget(instance);
                            }}
                          >
                            {translate('awsImport.badge.addRdp')}
                          </Button>
                        ) : null}
                        <Button
                          variant="primary"
                          disabled={!canAddEc2Instance(instance)}
                          onClick={async () => {
                            if (!canAddEc2Instance(instance)) {
                              return;
                            }
                            if (isWindowsEc2Instance(instance)) {
                              beginWindowsRegistration(instance);
                              return;
                            }
                            await inspectInstance(instance, false);
                          }}
                        >
                          {getEc2ActionButtonLabel(instance)}
                        </Button>
                      </CardActions>
                    </Card>
                  ))
                )}
              </PanelSection>
            </div>
          ) : profileStatus?.isAuthenticated && regions.length > 0 ? (
            <EmptyState
              title={
                importMode === 'ecs'
                  ? translate('awsImport.empty.selectRegionEcs')
                  : translate('awsImport.empty.selectRegionEc2')
              }
              data-testid="aws-import-region-hint"
            />
          ) : null}
        </ModalBody>

        <ModalFooter>
          {rdpTarget ? (
            <>
              <Button
                variant="secondary"
                disabled={rdpFetchStatus === 'loading' || isRegistering}
                onClick={resetRdpRegistration}
              >
                {translate('awsImport.action.back')}
              </Button>
              <Button
                variant="primary"
                // 비밀번호가 없으면 붙을 수 없는 호스트가 남는다. 가져오지 못했으면 직접 입력해야 한다.
                disabled={!rdpPassword.trim() || rdpFetchStatus === 'loading' || isRegistering}
                onClick={registerRdpInstance}
              >
                {translate(
                  isRegistering
                    ? 'awsImport.action.registering'
                    : 'awsImport.action.registerHost',
                )}
              </Button>
            </>
          ) : inspectionTarget ? (
            <>
              <Button
                variant="secondary"
                disabled={inspectionStatus === 'loading' || isRegistering}
                onClick={() => {
                  resetInspection();
                }}
              >
                {translate('awsImport.action.back')}
              </Button>
              <div className="ml-auto flex items-center justify-end gap-3">
                {/* 재검사는 SSH 메타데이터를 다시 읽는 것이라 Windows 에는 해당 없다. */}
                {isWindowsEc2Instance(inspectionTarget) ? null : (
                <Button
                  variant="secondary"
                  disabled={inspectionStatus === 'loading' || isRegistering}
                  onClick={() => {
                    void inspectInstance(inspectionTarget, true);
                  }}
                >
                  {translate('awsImport.action.recheck')}
                </Button>
                )}
                <Button
                  variant="primary"
                  disabled={inspectionStatus === 'loading' || isRegistering}
                  onClick={async () => {
                    try {
                      const sshPort = toAwsSshPortValue(inspectionPort);
                      const sshUsername = inspectionUsername.trim() || null;
                      setInspectionError(null);
                      setIsRegistering(true);
                      await onImport({
                        kind: 'aws-ec2',
                        label: inspectionTarget.name || inspectionTarget.instanceId,
                        groupName: currentGroupPath ?? '',
                        terminalThemeId: null,
                        awsProfileId: selectedProfileSummary?.id ?? null,
                        awsProfileName: selectedProfile,
                        awsRegion: selectedRegion,
                        awsInstanceId: inspectionTarget.instanceId,
                        awsAvailabilityZone: inspectionTarget.availabilityZone || null,
                        awsInstanceName: inspectionTarget.name || null,
                        awsPlatform: inspectionTarget.platform || null,
                        awsPrivateIp: inspectionTarget.privateIp || null,
                        awsState: inspectionTarget.state || null,
                        awsSshUsername: sshUsername,
                        awsSshPort: sshPort,
                        awsSshMetadataStatus: sshUsername ? 'ready' : 'idle',
                        awsSshMetadataError: null
                      });
                      onClose();
                    } catch (submitError) {
                      setInspectionStatus('error');
                      setInspectionError(submitError instanceof Error ? submitError.message : translate('awsImport.error.hostRegisterFailed'));
                    } finally {
                      setIsRegistering(false);
                    }
                  }}
                >
                  {translate(isRegistering ? 'awsImport.action.registering' : 'awsImport.action.registerHost')}
                </Button>
              </div>
            </>
          ) : (
            <div className="ml-auto flex items-center justify-end gap-3">
              <Button variant="secondary" onClick={onClose}>
                {translate('common.close')}
              </Button>
            </div>
          )}
        </ModalFooter>
        </ModalShell>
      </DialogBackdrop>
      <AwsExternalProfileImportDialog
        open={isExternalImportOpen}
        onClose={() => setIsExternalImportOpen(false)}
        onImported={(result) => handleExternalImportSuccess(result)}
        listExternalProfiles={listExternalAwsProfiles}
        getExternalProfileDetails={getExternalAwsProfileDetails}
        importExternalProfiles={importExternalAwsProfiles}
      />
    </>
  );
}
