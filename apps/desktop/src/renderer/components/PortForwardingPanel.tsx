import { useMemo, useState } from 'react';
import type { HostRecord, PortForwardDraft, PortForwardRuleRecord, PortForwardRuntimeRecord } from '@shared';

interface PortForwardingPanelProps {
  hosts: HostRecord[];
  rules: PortForwardRuleRecord[];
  runtimes: PortForwardRuntimeRecord[];
  onSave: (ruleId: string | null, draft: PortForwardDraft) => Promise<void>;
  onRemove: (ruleId: string) => Promise<void>;
  onStart: (ruleId: string) => Promise<void>;
  onStop: (ruleId: string) => Promise<void>;
}

function emptyDraft(hostId?: string): PortForwardDraft {
  return {
    label: '',
    hostId: hostId ?? '',
    mode: 'local',
    bindAddress: '127.0.0.1',
    bindPort: 9000,
    targetHost: '127.0.0.1',
    targetPort: 80
  };
}

function toDraft(rule: PortForwardRuleRecord): PortForwardDraft {
  return {
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

export function PortForwardingPanel({ hosts, rules, runtimes, onSave, onRemove, onStart, onStop }: PortForwardingPanelProps) {
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PortForwardDraft>(() => emptyDraft(hosts[0]?.id));
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runtimeMap = useMemo(() => new Map(runtimes.map((runtime) => [runtime.ruleId, runtime])), [runtimes]);

  function openCreate() {
    setEditingRuleId(null);
    setDraft(emptyDraft(hosts[0]?.id));
    setError(null);
    setIsModalOpen(true);
  }

  function openEdit(rule: PortForwardRuleRecord) {
    setEditingRuleId(rule.id);
    setDraft(toDraft(rule));
    setError(null);
    setIsModalOpen(true);
  }

  async function handleSubmit() {
    if (!draft.label.trim()) {
      setError('Label을 입력해 주세요.');
      return;
    }
    if (!draft.hostId) {
      setError('Host를 선택해 주세요.');
      return;
    }
    if (draft.bindPort <= 0) {
      setError('Bind port를 올바르게 입력해 주세요.');
      return;
    }
    if (draft.mode !== 'dynamic' && (!draft.targetHost?.trim() || !draft.targetPort || draft.targetPort <= 0)) {
      setError('Target host / port를 올바르게 입력해 주세요.');
      return;
    }
    await onSave(editingRuleId, {
      ...draft,
      targetHost: draft.mode === 'dynamic' ? null : draft.targetHost?.trim() ?? null,
      targetPort: draft.mode === 'dynamic' ? null : draft.targetPort ?? null
    });
    setIsModalOpen(false);
  }

  return (
    <div className="operations-panel">
      <div className="operations-panel__header">
        <div>
          <div className="section-kicker">Forwarding</div>
          <h2>Port Forwarding</h2>
          <p>로컬, 리모트, 다이내믹 포워딩 규칙을 저장하고 필요할 때만 실행합니다.</p>
        </div>
        <button type="button" className="primary-button" onClick={openCreate}>
          New Forward
        </button>
      </div>

      <div className="operations-list">
        {rules.length === 0 ? (
          <div className="empty-callout">
            <strong>아직 저장된 포워딩 규칙이 없습니다.</strong>
            <p>New Forward를 눌러 첫 번째 포워딩 규칙을 만들어 보세요.</p>
          </div>
        ) : (
          rules.map((rule) => {
            const runtime = runtimeMap.get(rule.id);
            const host = hosts.find((item) => item.id === rule.hostId);
            const isRunning = runtime?.status === 'running' || runtime?.status === 'starting';
            return (
              <article key={rule.id} className="operations-card">
                <div className="operations-card__main">
                  <div className="operations-card__title-row">
                    <strong>{rule.label}</strong>
                    <span className={`status-pill status-pill--${runtime?.status ?? 'stopped'}`}>{statusLabel(runtime)}</span>
                  </div>
                  <div className="operations-card__meta">
                    <span>{rule.mode.toUpperCase()}</span>
                    <span>{host ? `${host.label} (${host.hostname})` : 'Unknown host'}</span>
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
        <div className="modal-backdrop" role="presentation">
          <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="port-forward-title">
            <div className="modal-card__header">
              <div>
                <div className="section-kicker">Forwarding</div>
                <h3 id="port-forward-title">{editingRuleId ? 'Edit Forward' : 'New Forward'}</h3>
              </div>
              <button type="button" className="icon-button" onClick={() => setIsModalOpen(false)}>
                ×
              </button>
            </div>

            <div className="modal-card__body form-grid">
              <label className="form-field">
                <span>Label</span>
                <input value={draft.label} onChange={(event) => setDraft((current) => ({ ...current, label: event.target.value }))} />
              </label>

              <label className="form-field">
                <span>Host</span>
                <select value={draft.hostId} onChange={(event) => setDraft((current) => ({ ...current, hostId: event.target.value }))}>
                  <option value="">Select host</option>
                  {hosts.map((host) => (
                    <option key={host.id} value={host.id}>
                      {host.label} ({host.hostname})
                    </option>
                  ))}
                </select>
              </label>

              <label className="form-field">
                <span>Mode</span>
                <select
                  value={draft.mode}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      mode: event.target.value as PortForwardDraft['mode']
                    }))
                  }
                >
                  <option value="local">Local</option>
                  <option value="remote">Remote</option>
                  <option value="dynamic">Dynamic</option>
                </select>
              </label>

              <label className="form-field">
                <span>Bind address</span>
                <input value={draft.bindAddress} onChange={(event) => setDraft((current) => ({ ...current, bindAddress: event.target.value }))} />
              </label>

              <label className="form-field">
                <span>Bind port</span>
                <input
                  type="number"
                  value={draft.bindPort}
                  onChange={(event) => setDraft((current) => ({ ...current, bindPort: Number(event.target.value) }))}
                />
              </label>

              {draft.mode !== 'dynamic' ? (
                <>
                  <label className="form-field">
                    <span>Target host</span>
                    <input
                      value={draft.targetHost ?? ''}
                      onChange={(event) => setDraft((current) => ({ ...current, targetHost: event.target.value }))}
                    />
                  </label>

                  <label className="form-field">
                    <span>Target port</span>
                    <input
                      type="number"
                      value={draft.targetPort ?? ''}
                      onChange={(event) => setDraft((current) => ({ ...current, targetPort: Number(event.target.value) }))}
                    />
                  </label>
                </>
              ) : null}

              {error ? <div className="form-error">{error}</div> : null}
            </div>

            <div className="modal-card__footer">
              <button type="button" className="secondary-button" onClick={() => setIsModalOpen(false)}>
                취소
              </button>
              <button type="button" className="primary-button" onClick={() => void handleSubmit()}>
                저장
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
