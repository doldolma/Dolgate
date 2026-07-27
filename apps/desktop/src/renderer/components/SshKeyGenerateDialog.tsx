import { useState } from 'react';
import type { SshKeyGenerateInput } from '@shared';
import {
  Button,
  Input,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalShell,
  SectionLabel,
  ToggleSwitch,
} from '../ui';
import { DialogBackdrop } from './DialogBackdrop';
import { useTranslation } from 'react-i18next';

type SshKeyAlgorithm = NonNullable<SshKeyGenerateInput['algorithm']>;
type SshKeyCurve = NonNullable<SshKeyGenerateInput['curve']>;
type SshRsaBits = NonNullable<SshKeyGenerateInput['rsaBits']>;
type SshPrivateKeyCipher = NonNullable<SshKeyGenerateInput['privateKeyCipher']>;

interface SshKeyGenerateDialogProps {
  title?: string;
  sectionLabel?: string;
  initialLabel?: string;
  initialComment?: string;
  submitLabel?: string;
  busy?: boolean;
  error?: string | null;
  onDismiss: () => void;
  onSubmit: (input: SshKeyGenerateInput) => void | Promise<void>;
}

const algorithms: Array<{ value: SshKeyAlgorithm; label: string }> = [
  { value: 'ed25519', label: 'ED25519' },
  { value: 'ecdsa', label: 'ECDSA' },
  { value: 'rsa', label: 'RSA' },
];

const curves: Array<{ value: SshKeyCurve; label: string }> = [
  { value: 'nistp521', label: '521' },
  { value: 'nistp384', label: '384' },
  { value: 'nistp256', label: '256' },
];

const rsaBits: Array<{ value: SshRsaBits; label: string }> = [
  { value: 4096, label: '4096' },
  { value: 3072, label: '3072' },
];

const privateKeyCiphers: Array<{ value: SshPrivateKeyCipher; label: string }> = [
  { value: 'aes256-ctr', label: 'AES-256 CTR' },
  { value: 'aes256-cbc', label: 'AES-256 CBC' },
];

const DEFAULT_KDF_ROUNDS = 100;
const MAX_KDF_ROUNDS = 2048;

function normalizeKdfRounds(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_KDF_ROUNDS;
  }
  return Math.min(parsed, MAX_KDF_ROUNDS);
}

function SegmentedControl<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="grid gap-2">
      <span className="text-sm font-semibold text-[var(--accent-strong)]">{label}</span>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(6rem,1fr))] gap-2 rounded-[10px] border border-[var(--border)] bg-[var(--surface-muted)] p-1">
        {options.map((option) => (
          <Button
            key={String(option.value)}
            variant="ghost"
            active={option.value === value}
            onClick={() => onChange(option.value)}
            className="rounded-[10px] border-transparent"
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function SshKeyGenerateDialog({
  title = 'Generate SSH Key',
  sectionLabel = 'SSH Key',
  initialLabel = '',
  initialComment = '',
  submitLabel = 'Generate',
  busy = false,
  error,
  onDismiss,
  onSubmit,
}: SshKeyGenerateDialogProps) {
  const { t: translate } = useTranslation();
  const [label, setLabel] = useState(initialLabel);
  const [comment, setComment] = useState(initialComment);
  const [algorithm, setAlgorithm] = useState<SshKeyAlgorithm>('ed25519');
  const [curve, setCurve] = useState<SshKeyCurve>('nistp521');
  const [bits, setBits] = useState<SshRsaBits>(4096);
  const [passphrase, setPassphrase] = useState('');
  const [privateKeyCipher, setPrivateKeyCipher] =
    useState<SshPrivateKeyCipher>('aes256-ctr');
  const [kdfRounds, setKdfRounds] = useState(String(DEFAULT_KDF_ROUNDS));
  const [savePassphrase, setSavePassphrase] = useState(false);

  const normalizedPassphrase = passphrase.trim();
  const hasPassphrase = normalizedPassphrase.length > 0;

  return (
    <DialogBackdrop onDismiss={onDismiss}>
      <ModalShell role="dialog" aria-modal="true" aria-labelledby="generate-ssh-key-title" size="lg">
        <ModalHeader className="block">
          <SectionLabel>{sectionLabel}</SectionLabel>
          <h3 id="generate-ssh-key-title">{title}</h3>
        </ModalHeader>
        <ModalBody className="grid gap-5">
          <div className="grid gap-4 rounded-[12px] bg-[var(--surface-elevated)] p-4">
            <label className="grid gap-2">
              <span className="text-sm font-semibold">Label</span>
              <Input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Production access key"
                autoFocus
              />
            </label>

            <SegmentedControl
              label="Key type"
              value={algorithm}
              options={algorithms}
              onChange={setAlgorithm}
            />

            {algorithm === 'ecdsa' ? (
              <SegmentedControl
                label="Elliptic curve size (bits)"
                value={curve}
                options={curves}
                onChange={setCurve}
              />
            ) : null}

            {algorithm === 'rsa' ? (
              <SegmentedControl
                label="RSA key size (bits)"
                value={bits}
                options={rsaBits}
                onChange={setBits}
              />
            ) : null}

            <label className="grid gap-2">
              <span className="text-sm font-semibold">Comment</span>
              <Input
                value={comment}
                onChange={(event) => setComment(event.target.value)}
                placeholder="user@example.com"
              />
            </label>
          </div>

          <div className="grid gap-4 rounded-[12px] bg-[var(--surface-elevated)] p-4">
            <label className="grid gap-2">
              <span className="text-sm font-semibold">Passphrase</span>
              <Input
                type="password"
                value={passphrase}
                onChange={(event) => setPassphrase(event.target.value)}
                placeholder="Optional"
              />
            </label>
            {hasPassphrase ? (
              <>
                <SegmentedControl
                  label="Cipher"
                  value={privateKeyCipher}
                  options={privateKeyCiphers}
                  onChange={setPrivateKeyCipher}
                />
                <label className="grid gap-2">
                  <span className="text-sm font-semibold">Rounds</span>
                  <Input
                    type="number"
                    min={1}
                    max={MAX_KDF_ROUNDS}
                    value={kdfRounds}
                    onChange={(event) => setKdfRounds(event.target.value)}
                  />
                </label>
              </>
            ) : null}
            <ToggleSwitch
              checked={Boolean(hasPassphrase && savePassphrase)}
              disabled={!hasPassphrase}
              label="Save passphrase"
              description={
                hasPassphrase
                  ? 'Store it with this credential for automatic key use.'
                  : 'Enter a passphrase to enable saving.'
              }
              onClick={() => setSavePassphrase((current) => !current)}
            />
          </div>

          {error ? (
            <div role="alert" className="text-sm font-semibold text-[var(--danger-text)]">
              {error}
            </div>
          ) : null}
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" disabled={busy} onClick={onDismiss}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy || label.trim().length === 0}
            onClick={() =>
              void onSubmit({
                label,
                comment,
                algorithm,
                curve: algorithm === 'ecdsa' ? curve : undefined,
                rsaBits: algorithm === 'rsa' ? bits : undefined,
                privateKeyCipher: hasPassphrase ? privateKeyCipher : undefined,
                kdfRounds: hasPassphrase ? normalizeKdfRounds(kdfRounds) : undefined,
                passphrase: normalizedPassphrase || undefined,
                savePassphrase: Boolean(hasPassphrase && savePassphrase),
              })
            }
          >
            {busy ? translate('misc.generating') : submitLabel}
          </Button>
        </ModalFooter>
      </ModalShell>
    </DialogBackdrop>
  );
}
