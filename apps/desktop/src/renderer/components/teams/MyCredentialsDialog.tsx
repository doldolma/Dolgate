import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  isRdpHostRecord,
  isSshHostRecord,
  type AuthType,
  type MyHostCredentialsInput,
  type MyHostCredentialsSummary,
  type RdpHostRecord,
  type SshHostRecord,
  type VncHostRecord,
} from '@shared';
import { pickPrivateKey, pickSshCertificate } from '../../services/desktop/settings';
import { Button, Input, SelectField, Tooltip } from '../../ui';
import { Info } from '../../ui/icons';
import { TeamDialogError, TeamDialogFrame } from './TeamDialogFrame';
import { useDialogAction } from './useDialogAction';

/** 내 자격 증명을 둘 수 있는 팀 호스트 — 비밀값으로 붙는 종류. */
export type MyCredentialsHost = SshHostRecord | RdpHostRecord | VncHostRecord;

// 호스트 편집과 같은 칸 모양(HostForm 의 fieldClassName·fieldLabelClassName).
const FIELD = 'flex flex-col gap-[0.4rem] text-[var(--text)]';
const LABEL = 'text-[0.82rem] font-semibold uppercase tracking-[0.12em] text-[var(--text-soft)]';
// 호스트 편집의 인증 방식 고르기와 같은 넷.
const SSH_AUTH_TYPES = ['password', 'privateKey', 'certificate', 'agent'] as const;
const AUTH_LABEL_KEYS: Partial<Record<AuthType, string>> = {
  password: 'hostForm.option.authPassword',
  privateKey: 'hostForm.option.authPrivateKey',
  certificate: 'hostForm.option.authCertificate',
  agent: 'hostForm.option.authAgent',
};

/** 인증 방식 이름 — 호스트 편집과 같은 말. */
export function authTypeLabel(authType: AuthType | null | undefined, translate: (key: string) => string): string {
  const key = authType ? AUTH_LABEL_KEYS[authType] : undefined;
  return key ? translate(key) : (authType ?? '');
}

interface PickedFile {
  name: string;
  content: string;
}

interface MyCredentialsDialogProps {
  host: MyCredentialsHost;
  /** 지금 둔 것(비밀값 없이). 없으면 null. */
  summary: MyHostCredentialsSummary | null;
  onSave: (input: MyHostCredentialsInput) => Promise<void>;
  onClear: () => Promise<void>;
  onClose: () => void;
}

/**
 * 팀 호스트의 내 자격 증명 편집(후보 D1). 호스트 편집 창을 떼어 쓰지 않고 같은 부품·같은 키 가져오기로 짠다.
 * 빈 칸은 보내지 않는다 — 이름·방식은 팀 것으로 돌아가고, 저장된 비밀값은 메인이 그대로 둔다(방식이 같을 때).
 */
export function MyCredentialsDialog({ host, summary, onSave, onClear, onClose }: MyCredentialsDialogProps) {
  const { t: translate } = useTranslation();
  const { busy, error, run } = useDialogAction('teams.myCredentials.saveFailed');
  const ssh = isSshHostRecord(host) ? host : null;
  const rdp = isRdpHostRecord(host);
  const [username, setUsername] = useState(summary?.username ?? '');
  const [authType, setAuthType] = useState<AuthType | ''>(ssh ? (summary?.authType ?? '') : '');
  const [password, setPassword] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [privateKey, setPrivateKey] = useState<PickedFile | null>(null);
  const [certificate, setCertificate] = useState<PickedFile | null>(null);
  const [domain, setDomain] = useState(summary?.domain ?? '');

  // 쓰일 방식 — 비우면 팀 것. RDP·VNC 는 비밀번호뿐이다.
  const effectiveAuth: AuthType = ssh ? authType || ssh.authType : 'password';
  const usesKey = effectiveAuth === 'privateKey' || effectiveAuth === 'certificate';
  // 저장된 비밀값은 방식이 그대로일 때만 남는다(메인 규칙) — 그때만 "비워 두면 그대로 유지".
  const keepsStored = (authType || null) === (summary?.authType ?? null);
  const keepBlank = translate('hostForm.placeholder.keepBlank');
  const keepIf = (stored: boolean | undefined, fallback = '') => (stored && keepsStored ? keepBlank : fallback);

  const pickFile = (pick: () => Promise<PickedFile | null>, set: (file: PickedFile) => void) => {
    void Promise.resolve()
      .then(pick)
      .then((file) => {
        if (file) {
          set({ name: file.name, content: file.content });
        }
      });
  };

  const save = () => {
    const input: MyHostCredentialsInput = {
      ...(username.trim() && (ssh || rdp) ? { username: username.trim() } : {}),
      ...(ssh && authType ? { authType } : {}),
      ...(rdp && domain.trim() ? { domain: domain.trim() } : {}),
      ...(password && effectiveAuth === 'password' ? { password } : {}),
      ...(privateKey && usesKey ? { privateKeyPem: privateKey.content } : {}),
      ...(certificate && effectiveAuth === 'certificate' ? { certificateText: certificate.content } : {}),
      ...(passphrase && usesKey ? { passphrase } : {}),
    };
    void run(() => onSave(input)).then((done) => done && onClose());
  };
  const clear = () => void run(onClear).then((done) => done && onClose());

  return (
    <TeamDialogFrame
      section="Credentials"
      title={
        <span className="inline-flex items-center gap-[0.35rem]">
          {translate('teams.myCredentials.title', { host: host.label })}
          <Tooltip label={translate('teams.myCredentials.dialogHint')} multiline>
            <Info className="h-4 w-4 text-[var(--text-soft)]" aria-hidden />
          </Tooltip>
        </span>
      }
      busy={busy}
      onClose={onClose}
      footer={
        <>
          {summary ? (
            <Button variant="ghost" className="mr-auto text-[var(--danger-text)]" onClick={clear} disabled={busy}>
              {translate('teams.myCredentials.clear')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            {translate('common.cancel')}
          </Button>
          <Button variant="primary" onClick={save} disabled={busy}>
            {translate('common.save')}
          </Button>
        </>
      }
    >
      {ssh || rdp ? (
        <label className={FIELD}>
          <span className={LABEL}>{translate(rdp ? 'teams.myCredentials.account' : 'hostForm.field.username')}</span>
          <Input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder={ssh?.username ? translate('teams.myCredentials.teamValue', { value: ssh.username }) : ''}
          />
        </label>
      ) : null}
      {ssh ? (
        <label className={FIELD}>
          <span className={LABEL}>{translate('hostForm.field.authType')}</span>
          <SelectField value={authType} onChange={(event) => setAuthType(event.target.value as AuthType | '')}>
            <option value="">
              {translate('teams.myCredentials.teamAuth', { auth: authTypeLabel(ssh.authType, translate) })}
            </option>
            {SSH_AUTH_TYPES.map((type) => (
              <option key={type} value={type}>
                {authTypeLabel(type, translate)}
              </option>
            ))}
          </SelectField>
        </label>
      ) : null}
      {effectiveAuth === 'password' ? (
        <label className={FIELD}>
          <span className={LABEL}>{translate('hostForm.field.password')}</span>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={keepIf(summary?.hasPassword)}
          />
        </label>
      ) : null}
      {ssh && usesKey ? (
        <>
          <label className={FIELD}>
            <span className={LABEL}>{translate('hostForm.field.privateKeyFile')}</span>
            <div className="flex gap-[0.7rem]">
              <Input readOnly value={privateKey?.name ?? ''} placeholder={keepIf(summary?.hasPrivateKey, '/Users/.../.ssh/id_ed25519')} />
              <Button variant="secondary" onClick={() => pickFile(pickPrivateKey, setPrivateKey)}>
                {translate('hostForm.action.import')}
              </Button>
            </div>
          </label>
          {effectiveAuth === 'certificate' ? (
            <label className={FIELD}>
              <span className={LABEL}>{translate('hostForm.field.certificateFile')}</span>
              <div className="flex gap-[0.7rem]">
                <Input
                  readOnly
                  value={certificate?.name ?? ''}
                  placeholder={keepIf(summary?.hasCertificate, '/Users/.../.ssh/id_ed25519-cert.pub')}
                />
                <Button variant="secondary" onClick={() => pickFile(pickSshCertificate, setCertificate)}>
                  {translate('hostForm.action.import')}
                </Button>
              </div>
            </label>
          ) : null}
          <label className={FIELD}>
            <span className={LABEL}>{translate('hostForm.field.passphrase')}</span>
            <Input
              type="password"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
              placeholder={keepIf(summary?.hasPassphrase)}
            />
          </label>
        </>
      ) : null}
      {rdp ? (
        <label className={FIELD}>
          <span className={LABEL}>{translate('teams.myCredentials.domain')}</span>
          <Input value={domain} onChange={(event) => setDomain(event.target.value)} />
        </label>
      ) : null}
      <TeamDialogError message={error} />
    </TeamDialogFrame>
  );
}
