import React from 'react';
import { useTranslation } from 'react-i18next';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import type { PendingRdpCertificatePromptState } from '../store/useMobileAppStore';
import { useMobilePalette } from '../theme';

interface RdpCertificatePromptModalProps {
  prompt: PendingRdpCertificatePromptState | null;
  onAccept: () => void;
  onReject: () => void;
}

export function RdpCertificatePromptModal({
  prompt,
  onAccept,
  onReject,
}: RdpCertificatePromptModalProps): React.JSX.Element {
  const palette = useMobilePalette();
  const { t } = useTranslation();
  const changed = Boolean(prompt?.previousFingerprint);

  return (
    <Modal
      animationType="fade"
      transparent
      visible={Boolean(prompt)}
      onRequestClose={onReject}
    >
      <View style={[styles.overlay, { backgroundColor: palette.overlay }]}>
        <View
          style={[
            styles.card,
            {
              backgroundColor: palette.surfaceSolid,
              borderColor: palette.border,
            },
          ]}
        >
          <Text style={[styles.title, { color: palette.text }]}>
            {changed
              ? t('rdpCertificate.titleChanged', {
                  defaultValue: 'RDP 인증서가 변경됨',
                })
              : t('rdpCertificate.titleNew', {
                  defaultValue: 'RDP 인증서 확인',
                })}
          </Text>
          <Text style={[styles.body, { color: palette.mutedText }]}>
            {t('rdpCertificate.body', {
              label: prompt?.hostLabel ?? '',
              defaultValue:
                '{{label}} 서버가 제시한 인증서입니다. 다른 경로로 지문을 확인한 뒤 계속하세요.',
            })}
          </Text>

          <View
            style={[
              styles.infoBox,
              {
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.border,
              },
            ]}
          >
            <InfoRow
              label={t('rdpCertificate.host', { defaultValue: '호스트' })}
              value={prompt?.logicalHost ?? ''}
              color={palette.text}
              mutedColor={palette.mutedText}
            />
            <InfoRow
              label="SHA-256 fingerprint"
              value={prompt?.fingerprint ?? ''}
              color={palette.text}
              mutedColor={palette.mutedText}
              mono
            />
            {prompt?.previousFingerprint ? (
              <InfoRow
                label={t('rdpCertificate.previousFingerprint', {
                  defaultValue: '이전 fingerprint',
                })}
                value={prompt.previousFingerprint}
                color={palette.warning}
                mutedColor={palette.mutedText}
                mono
              />
            ) : null}
            {prompt?.subject ? (
              <InfoRow
                label={t('rdpCertificate.subject', { defaultValue: 'Subject' })}
                value={prompt.subject}
                color={palette.text}
                mutedColor={palette.mutedText}
              />
            ) : null}
            {prompt?.issuer ? (
              <InfoRow
                label={t('rdpCertificate.issuer', { defaultValue: 'Issuer' })}
                value={prompt.issuer}
                color={palette.text}
                mutedColor={palette.mutedText}
              />
            ) : null}
            {prompt?.notAfter ? (
              <InfoRow
                label={t('rdpCertificate.expires', { defaultValue: '만료' })}
                value={prompt.notAfter}
                color={palette.text}
                mutedColor={palette.mutedText}
              />
            ) : null}
          </View>

          <View style={styles.actions}>
            <Pressable
              onPress={onReject}
              style={[
                styles.secondaryButton,
                {
                  backgroundColor: palette.surfaceAlt,
                  borderColor: palette.border,
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('rdpCertificate.reject', {
                defaultValue: '연결 거부',
              })}
            >
              <Text style={[styles.buttonText, { color: palette.text }]}>
                {t('rdpCertificate.reject', { defaultValue: '연결 거부' })}
              </Text>
            </Pressable>
            <Pressable
              onPress={onAccept}
              style={[
                styles.primaryButton,
                { backgroundColor: palette.accent },
              ]}
              accessibilityRole="button"
              accessibilityLabel={t('rdpCertificate.trust', {
                defaultValue: '신뢰하고 연결',
              })}
            >
              <Text style={[styles.buttonText, styles.primaryButtonText]}>
                {t('rdpCertificate.trust', { defaultValue: '신뢰하고 연결' })}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function InfoRow({
  label,
  value,
  color,
  mutedColor,
  mono = false,
}: {
  label: string;
  value: string;
  color: string;
  mutedColor: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.infoRow}>
      <Text style={[styles.label, { color: mutedColor }]}>{label}</Text>
      <Text style={[mono ? styles.monoValue : styles.value, { color }]}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'center', padding: 24 },
  card: { borderWidth: 1, borderRadius: 22, padding: 20, gap: 12 },
  title: { fontSize: 20, fontWeight: '800' },
  body: { fontSize: 14, lineHeight: 20 },
  infoBox: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 10 },
  infoRow: { gap: 4 },
  label: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  value: { fontSize: 14, fontWeight: '600' },
  monoValue: { fontSize: 12, lineHeight: 18, fontFamily: 'Menlo' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 6 },
  secondaryButton: {
    flex: 1,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  primaryButton: {
    flex: 1,
    borderRadius: 14,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: { fontSize: 15, fontWeight: '800' },
  primaryButtonText: { color: '#04111A' },
});
