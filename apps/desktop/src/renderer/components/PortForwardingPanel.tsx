import { useMemo, useState } from 'react';
import {
  isAwsEc2HostRecord,
  isAwsSsmPortForwardDraft,
  isAwsSsmPortForwardRuleRecord,
  isSshHostRecord,
  isSshPortForwardDraft,
  isSshPortForwardRuleRecord
} from '@shared';
import type { HostRecord, PortForwardDraft, PortForwardRuleRecord, PortForwardRuntimeRecord } from '@shared';
import { DialogBackdrop } from './DialogBackdrop';

type ForwardTab = 'ssh' | 'aws-ssm';

interface PortForwardingPanelProps {
  hosts: HostRecord[];
  rules: PortForwardRuleRecord[];
  runtimes: PortForwardRuntimeRecord[];
  onSave: (ruleId: string | null, draft: PortForwardDraft) => Promise<void>;
  onRemove: (ruleId: string) => Promise<void>;
  onStart: (ruleId: string) => Promise<void>;
  onStop: (ruleId: string) => Promise<void>;
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

function tabTitle(tab: ForwardTab) {
  return tab === 'ssh' ? 'SSH Forwarding' : 'AWS SSM';
}

function createButtonLabel(tab: ForwardTab) {
  return tab === 'ssh' ? 'New SSH Forward' : 'New AWS SSM Forward';
}

function emptyStateTitle(tab: ForwardTab) {
  return tab === 'ssh' ? '아직 저장한 SSH 포워딩 규칙이 없습니다.' : '아직 저장한 AWS SSM 포워딩 규칙이 없습니다.';
}

function emptyStateDescription(tab: ForwardTab) {
  return tab === 'ssh'
    ? 'New SSH Forward를 눌러 첫 번째 SSH 포워딩 규칙을 만들어 보세요.'
    : 'New AWS SSM Forward를 눌러 첫 번째 AWS SSM 포워딩 규칙을 만들어 보세요.';
}

export function filterPortForwardRules(rules: PortForwardRuleRecord[], tab: ForwardTab): PortForwardRuleRecord[] {
  return rules.filter((rule) => (tab === 'ssh' ? isSshPortForwardRuleRecord(rule) : isAwsSsmPortForwardRuleRecord(rule)));
}

export function getAvailablePortForwardHosts(hosts: HostRecord[], tab: ForwardTab): HostRecord[] {
  return tab === 'ssh' ? hosts.filter(isSshHostRecord) : hosts.filter(isAwsEc2HostRecord);
}

export function shouldShowAwsRemoteHostField(draft: PortForwardDraft): boolean {
  return isAwsSsmPortForwardDraft(draft) && draft.targetKind === 'remote-host';
}

export function PortForwardingPanel({ hosts, rules, runtimes, onSave, onRemove, onStart, onStop }: PortForwardingPanelProps) {
  const [activeTab, setActiveTab] = useState<ForwardTab>('ssh');
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const sshHosts = useMemo(() => getAvailablePortForwardHosts(hosts, 'ssh').filter(isSshHostRecord), [hosts]);
  const awsHosts = useMemo(() => getAvailablePortForwardHosts(hosts, 'aws-ssm').filter(isAwsEc2HostRecord), [hosts]);
  const [draft, setDraft] = useState<PortForwardDraft>(() => emptySshDraft(sshHosts[0]?.id));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runtimeMap = useMemo(() => new Map(runtimes.map((runtime) => [runtime.ruleId, runtime])), [runtimes]);
  const visibleRules = useMemo(() => filterPortForwardRules(rules, activeTab), [activeTab, rules]);

  function openCreate(tab: ForwardTab = activeTab) {
    setActiveTab(tab);
    setEditingRuleId(null);
    setDraft(tab === 'ssh' ? emptySshDraft(sshHosts[0]?.id) : emptyAwsDraft(awsHosts[0]?.id));
    setIsSubmitting(false);
    setError(null);
    setIsModalOpen(true);
  }

  function openEdit(rule: PortForwardRuleRecord) {
    setEditingRuleId(rule.id);
    setActiveTab(rule.transport);
    setDraft(toDraft(rule));
    setIsSubmitting(false);
    setError(null);
    setIsModalOpen(true);
  }

  function closeModal() {
    if (isSubmitting) {
      return;
    }
    setIsModalOpen(false);
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
        setIsModalOpen(false);
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
      setIsModalOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '포워딩 규칙을 저장하지 못했습니다.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="operations-panel">
      <div className="operations-panel__header">
        <div>
          <div className="section-kicker">Forwarding</div>
          <h2>Port Forwarding</h2>
          <p>SSH 포워딩과 AWS SSM 포워딩 규칙을 관리하고 필요할 때만 실행합니다.</p>
        </div>
        <button type="button" className="primary-button" onClick={() => openCreate(activeTab)}>
          {createButtonLabel(activeTab)}
        </button>
      </div>

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
                      <span>
                        {host
                          ? `${host.label} (${host.awsProfileName} / ${host.awsRegion} / ${host.awsInstanceId})`
                          : 'Unknown AWS host'}
                      </span>
                      <span>
                        {(runtime?.bindAddress ?? rule.bindAddress) || '127.0.0.1'}:{runtime?.bindPort ?? rule.bindPort}
                      </span>
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
                    <span>{host ? `${host.label} (${host.hostname})` : 'Unknown SSH host'}</span>
                    <span>
                      {rule.bindAddress}:{runtime?.bindPort ?? rule.bindPort}
                    </span>
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
        <DialogBackdrop onDismiss={closeModal} dismissDisabled={isSubmitting}>
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="port-forward-title">
            <div className="modal-card__header">
              <div>
                <div className="section-kicker">Forwarding</div>
                <h3 id="port-forward-title">{editingRuleId ? `Edit ${tabTitle(activeTab)}` : createButtonLabel(activeTab)}</h3>
              </div>
              <button type="button" className="icon-button" onClick={closeModal} disabled={isSubmitting}>
                횞
              </button>
            </div>

            <div className="modal-card__body form-grid">
              <label className="form-field">
                <span>Label</span>
                <input
                  value={draft.label}
                  onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))}
                  disabled={isSubmitting}
                />
              </label>

              <label className="form-field">
                <span>{isAwsSsmPortForwardDraft(draft) ? 'AWS Host' : 'Host'}</span>
                <select
                  value={draft.hostId}
                  onChange={(event) => setDraft((current) => ({ ...current, hostId: event.target.value }))}
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

              {isSshPortForwardDraft(draft) ? (
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
                      onChange={(event) => setDraft((current) => ({ ...current, bindAddress: event.target.value }))}
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
                        setDraft((current) => ({
                          ...current,
                          targetKind: event.target.value as typeof draft.targetKind
                        }))
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

              <label className="form-field">
                <span>{isAwsSsmPortForwardDraft(draft) ? 'Local port' : 'Bind port'}</span>
                <input
                  type="number"
                  value={draft.bindPort}
                  onChange={(event) => setDraft((current) => ({ ...current, bindPort: Number(event.target.value) }))}
                  disabled={isSubmitting}
                />
              </label>

              {isSshPortForwardDraft(draft) && draft.mode !== 'dynamic' ? (
                <>
                  <label className="form-field">
                    <span>Target host</span>
                    <input
                      value={draft.targetHost ?? ''}
                      onChange={(event) => setDraft((current) => ({ ...current, targetHost: event.target.value }))}
                      disabled={isSubmitting}
                    />
                  </label>

                  <label className="form-field">
                    <span>Target port</span>
                    <input
                      type="number"
                      value={draft.targetPort ?? ''}
                      onChange={(event) => setDraft((current) => ({ ...current, targetPort: Number(event.target.value) }))}
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
                        onChange={(event) => setDraft((current) => ({ ...current, remoteHost: event.target.value }))}
                        disabled={isSubmitting}
                      />
                    </label>
                  ) : null}

                  <label className="form-field">
                    <span>Target port</span>
                    <input
                      type="number"
                      value={draft.targetPort}
                      onChange={(event) => setDraft((current) => ({ ...current, targetPort: Number(event.target.value) }))}
                      disabled={isSubmitting}
                    />
                  </label>
                </>
              ) : null}

              {error ? <div className="form-error">{error}</div> : null}
            </div>

            <div className="modal-card__footer">
              <button type="button" className="secondary-button" onClick={closeModal} disabled={isSubmitting}>
                취소
              </button>
              <button type="button" className="primary-button" onClick={() => void handleSubmit()} disabled={isSubmitting}>
                저장
              </button>
            </div>
          </div>
        </DialogBackdrop>
      ) : null}
    </div>
  );
}
