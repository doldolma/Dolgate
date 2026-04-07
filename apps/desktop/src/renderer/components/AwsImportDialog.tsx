import { useEffect, useMemo, useRef, useState } from 'react';
import {
  type AwsEc2InstanceSummary,
  type AwsEcsClusterListItem,
  type AwsHostSshInspectionResult,
  type AwsProfileStatus,
  type AwsProfileSummary,
  type HostDraft,
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

type AwsImportMode = 'ec2' | 'ecs';

interface AwsImportDialogProps {
  open: boolean;
  currentGroupPath: string | null;
  onClose: () => void;
  onImport: (draft: HostDraft) => Promise<void>;
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
    throw new Error('SSH 포트는 1에서 65535 사이 숫자여야 합니다.');
  }
  return parsed;
}

export function AwsImportDialog({ open, currentGroupPath, onClose, onImport }: AwsImportDialogProps) {
  const {
    createAwsProfile,
    getSyncStatus,
    getExternalAwsProfileDetails,
    getAwsProfileStatus,
    importExternalAwsProfiles,
    inspectAwsHostSshMetadata,
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
            : 'SSH 접속 정보를 자동으로 확인하지 못했습니다.',
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
        setError(loadError instanceof Error ? loadError.message : 'AWS 프로필 목록을 불러오지 못했습니다.');
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
        setError(loadError instanceof Error ? loadError.message : 'AWS 프로필 상태를 확인하지 못했습니다.');
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
        setError(loadError instanceof Error ? loadError.message : 'AWS 리전 목록을 불러오지 못했습니다.');
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
              ? 'ECS 클러스터 목록을 불러오지 못했습니다.'
              : 'EC2 인스턴스 목록을 불러오지 못했습니다.',
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
      parts.push(`가져온 프로필 ${result.importedProfileNames.length}개`)
    }
    if (result.skippedProfileNames.length > 0) {
      parts.push(`건너뜀 ${result.skippedProfileNames.length}개`)
    }
    setExternalImportSummary(parts.length > 0 ? `${parts.join(', ')}.` : null)
    const items = await listAwsProfiles()
    setProfiles(items)
    setSelectedProfile(
      resolveSelectedProfileName(items, result.importedProfileNames[0] ?? selectedProfile),
    )
  };

  const missingTools = useMemo(() => profileStatus?.missingTools ?? [], [profileStatus?.missingTools]);
  const shouldShowMissingToolsBanner =
    missingTools.includes('aws-cli') ||
    (importMode === 'ec2' && missingTools.includes('session-manager-plugin'));
  const loadingMessage = inspectionTarget
    ? null
    : isLoadingProfiles
      ? 'AWS 프로필을 불러오는 중입니다.'
      : isLoadingStatus
        ? '프로필 로그인 상태를 확인하는 중입니다.'
        : isLoggingIn
          ? '브라우저에서 AWS 로그인을 진행 중입니다.'
          : isLoadingRegions
            ? '리전 목록을 불러오는 중입니다.'
            : isLoadingInstances
              ? importMode === 'ecs'
                ? 'ECS 클러스터 목록을 불러오는 중입니다.'
                : 'EC2 인스턴스 목록을 불러오는 중입니다.'
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
            <h3 id="aws-import-title">Import from AWS</h3>
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
              EC2
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
              로컬 AWS CLI에서 가져오기
            </Button>
            <Button
              variant="secondary"
              disabled={Boolean(inspectionTarget) || isRegistering}
              onClick={() => {
                setIsCreateProfileOpen((current) => !current);
              }}
            >
              {isCreateProfileOpen ? '프로필 생성 닫기' : '프로필 생성'}
            </Button>
          </div>

          {isCreateProfileOpen ? (
            <Card data-testid="aws-create-profile-form" className="items-stretch">
              <CardMain>
                <AwsProfileCreateWizard
                  testId="aws-create-profile-fields"
                  title="새 AWS 프로필 생성"
                  descriptions={[
                    '앱 전용 AWS CLI 프로필로 저장됩니다.',
                    'Static, SSO, Role profile 생성이 모두 가능합니다.',
                    ...(awsProfilesServerSupport === 'unsupported'
                      ? ['현재 서버는 AWS 프로필 동기화를 지원하지 않아 이 기기에서만 저장됩니다.']
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
              현재 서버는 AWS 프로필 동기화를 아직 지원하지 않습니다. 서버를 업데이트하기 전까지 이 기기에서만 저장됩니다.
            </NoticeCard>
          ) : null}

          {loadingMessage ? <NoticeCard tone="info">{loadingMessage}</NoticeCard> : null}

          {shouldShowAwsProfileAuthError(profileStatus, isLoadingStatus) && profileStatus ? (
            <NoticeCard tone="danger" role="alert">
              {profileStatus.isSsoProfile
                ? '이 프로필은 아직 로그인되지 않았습니다. 브라우저에서 AWS SSO 로그인을 완료해 주세요.'
                : profileStatus.errorMessage || '이 프로필은 AWS CLI 자격 증명이 필요합니다.'}
            </NoticeCard>
          ) : null}

          {shouldShowMissingToolsBanner ? (
            <NoticeCard tone="danger" role="alert">
              {missingTools.includes('aws-cli') ? 'AWS CLI가 설치되어 있어야 합니다. ' : ''}
              {importMode === 'ec2' && missingTools.includes('session-manager-plugin')
                ? 'session-manager-plugin이 설치되어 있어야 SSM 연결을 시작할 수 있습니다.'
                : ''}
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
                    setError(loginError instanceof Error ? loginError.message : 'AWS SSO 로그인을 시작하지 못했습니다.');
                  } finally {
                    setIsLoggingIn(false);
                  }
                }}
                disabled={isLoggingIn}
              >
                {isLoggingIn ? '로그인 중...' : '브라우저에서 로그인'}
              </Button>
            </div>
          ) : null}

          {error ? (
            <NoticeCard tone="danger" role="alert">
              {error}
            </NoticeCard>
          ) : null}

          {inspectionTarget ? (
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

              {inspectionStatus === 'loading' ? (
                <NoticeCard tone="info">
                  유저명 및 SSH 접속 정보를 확인 중입니다.
                </NoticeCard>
              ) : null}

              {inspectionStatus === 'ready' ? (
                <NoticeCard
                  title="자동으로 SSH 접속 정보를 확인했습니다."
                >
                  <p>필요하면 아래 값을 바로 수정한 뒤 Host를 등록할 수 있습니다.</p>
                </NoticeCard>
              ) : null}

              {inspectionStatus === 'error' && inspectionError ? (
                <NoticeCard tone="danger" role="alert">
                  {inspectionError}
                </NoticeCard>
              ) : null}

              <div className="grid gap-4 md:grid-cols-2">
                <FieldGroup label="SSH Username">
                  <input
                    value={inspectionUsername}
                    onChange={(event) => {
                      usernameDirtyRef.current = true;
                      usernameValueRef.current = event.target.value;
                      setInspectionUsername(event.target.value);
                    }}
                    placeholder="자동으로 찾은 사용자명이 없으면 비워둘 수 있습니다."
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
                    placeholder="비워두면 기본값 22를 사용합니다."
                    disabled={inspectionStatus === 'loading' || isRegistering}
                  />
                </FieldGroup>
              </div>

              {inspectionCandidateChips.length > 0 ? (
                <div className="flex flex-wrap gap-[0.6rem]">
                  {inspectionCandidateChips.map((candidate) => (
                    <Button
                      key={candidate}
                      variant="secondary"
                      className="px-[0.95rem]"
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
            </div>
          ) : profileStatus?.isAuthenticated && selectedRegion && importMode === 'ecs' ? (
            <div className="mt-[0.95rem]" data-testid="aws-import-ecs-cluster-list">
              <PanelSection>
                {ecsClusters.length === 0 && !isLoadingInstances ? (
                  <EmptyState title="이 리전에 가져올 수 있는 ECS 클러스터가 없습니다." />
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
                                  : 'ECS 클러스터를 가져오지 못했습니다.',
                              );
                            } finally {
                              setIsRegistering(false);
                            }
                          }}
                        >
                          {isRegistering ? '추가 중...' : '클러스터 추가'}
                        </Button>
                      </CardActions>
                    </Card>
                  ))
                )}
              </PanelSection>
            </div>
          ) : profileStatus?.isAuthenticated && selectedRegion ? (
            <div className="mt-[0.95rem]" data-testid="aws-import-instance-list">
              <PanelSection>
              {instances.length === 0 && !isLoadingInstances ? (
                <EmptyState title="이 리전에 가져올 수 있는 EC2 인스턴스가 없습니다." />
              ) : (
                instances.map((instance) => (
                  <Card key={instance.instanceId}>
                    <CardMain>
                      <CardTitleRow>
                        <strong>{instance.name || instance.instanceId}</strong>
                        <StatusBadge tone="running">{instance.state || 'unknown'}</StatusBadge>
                      </CardTitleRow>
                      <CardMeta>
                        <span>{instance.instanceId}</span>
                        <span>{selectedRegion}</span>
                        <span>{instance.availabilityZone || 'AZ unavailable'}</span>
                        <span>{instance.privateIp || 'No private IP'}</span>
                        <span>{instance.platform || 'linux'}</span>
                      </CardMeta>
                    </CardMain>
                    <CardActions>
                      <Button
                        variant="primary"
                        disabled={
                          /windows/i.test(instance.platform || '')
                        }
                        onClick={async () => {
                          await inspectInstance(instance, false);
                        }}
                      >
                        {/windows/i.test(instance.platform || '') ? 'Windows 미지원' : 'SSH 정보 확인'}
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
                  ? '리전을 선택하면 ECS 클러스터를 불러옵니다.'
                  : '리전을 선택하면 EC2 인스턴스를 불러옵니다.'
              }
              data-testid="aws-import-region-hint"
            />
          ) : null}
        </ModalBody>

        <ModalFooter>
          {inspectionTarget ? (
            <>
              <Button
                variant="secondary"
                disabled={inspectionStatus === 'loading' || isRegistering}
                onClick={() => {
                  resetInspection();
                }}
              >
                뒤로
              </Button>
              <div className="ml-auto flex items-center justify-end gap-3">
                <Button
                  variant="secondary"
                  disabled={inspectionStatus === 'loading' || isRegistering}
                  onClick={() => {
                    void inspectInstance(inspectionTarget, true);
                  }}
                >
                  다시 확인
                </Button>
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
                      setInspectionError(submitError instanceof Error ? submitError.message : 'AWS host를 등록하지 못했습니다.');
                    } finally {
                      setIsRegistering(false);
                    }
                  }}
                >
                  {isRegistering ? '등록 중...' : 'Host 등록'}
                </Button>
              </div>
            </>
          ) : (
            <div className="ml-auto flex items-center justify-end gap-3">
              <Button variant="secondary" onClick={onClose}>
                닫기
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
