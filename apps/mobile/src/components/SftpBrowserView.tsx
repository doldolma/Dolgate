import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Ionicons from 'react-native-vector-icons/Ionicons';
import type {
  FileEntry,
  MobileSftpSessionRecord,
  MobileSftpTransferRecord,
} from '@dolssh/shared-core';
import type { MobilePalette } from '../theme';

type PromptKind = 'mkdir' | 'rename' | 'chmod';

interface PromptState {
  kind: PromptKind;
  entry?: FileEntry;
  value: string;
}

interface SftpBrowserViewProps {
  palette: MobilePalette;
  session: MobileSftpSessionRecord;
  transfers: MobileSftpTransferRecord[];
  onNavigate: (path: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onUpload: () => Promise<void>;
  onDownload: (path: string) => Promise<void>;
  onDownloadEntries: (paths: string[]) => Promise<void>;
  onMkdir: (name: string) => Promise<void>;
  onRename: (sourcePath: string, nextName: string) => Promise<void>;
  onChmod: (path: string, mode: string) => Promise<void>;
  onDelete: (paths: string[]) => Promise<void>;
  copyBufferCount: number;
  onCopy: (paths: string[]) => void;
  onPaste: () => Promise<void>;
  onClearCopy: () => void;
}

export function SftpBrowserView({
  palette,
  session,
  transfers,
  onNavigate,
  onRefresh,
  onUpload,
  onDownload,
  onDownloadEntries,
  onMkdir,
  onRename,
  onChmod,
  onDelete,
  copyBufferCount,
  onCopy,
  onPaste,
  onClearCopy,
}: SftpBrowserViewProps): React.JSX.Element {
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionEntry, setActionEntry] = useState<FileEntry | null>(null);
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const pendingActionAfterModalDismiss = useRef<(() => void) | null>(null);

  const entries = useMemo(() => {
    const listingEntries = session.listing?.entries ?? [];
    return [...listingEntries].sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) {
        return left.isDirectory ? -1 : 1;
      }
      return left.name.localeCompare(right.name);
    });
  }, [session.listing?.entries]);

  const activeTransfers = transfers.filter(
    transfer =>
      transfer.sftpSessionId === session.id &&
      (transfer.status === 'running' || transfer.status === 'error'),
  );
  const currentPath = session.currentPath || '.';
  const canGoUp = currentPath !== '.' && currentPath !== '/';
  const selectedPathSet = useMemo(
    () => new Set(selectedPaths),
    [selectedPaths],
  );
  const isSelectionMode = selectedPaths.length > 0;

  useEffect(() => {
    setSelectedPaths([]);
  }, [session.id, currentPath]);

  const runAction = async (key: string, action: () => Promise<void>) => {
    setBusyAction(key);
    try {
      await action();
    } catch (error) {
      Alert.alert(
        'SFTP 작업 실패',
        error instanceof Error ? error.message : '작업을 완료하지 못했습니다.',
      );
    } finally {
      setBusyAction(null);
    }
  };

  const toggleSelection = (path: string) => {
    setSelectedPaths(current => {
      if (current.includes(path)) {
        return current.filter(candidate => candidate !== path);
      }
      return [...current, path];
    });
  };

  const clearSelection = () => setSelectedPaths([]);

  const flushActionAfterModalDismiss = useCallback(() => {
    const action = pendingActionAfterModalDismiss.current;
    if (!action) {
      return;
    }
    pendingActionAfterModalDismiss.current = null;
    setTimeout(action, 0);
  }, []);

  const runAfterActionModalClose = (action: () => void) => {
    pendingActionAfterModalDismiss.current = action;
    setActionEntry(null);
    setTimeout(flushActionAfterModalDismiss, 700);
  };

  const runSelectedAction = async (
    key: string,
    action: (paths: string[]) => Promise<void>,
  ) => {
    const paths = [...selectedPaths];
    if (paths.length === 0) {
      return;
    }
    clearSelection();
    await runAction(key, () => action(paths));
  };

  const submitPrompt = async () => {
    if (!prompt) {
      return;
    }
    const value = prompt.value.trim();
    if (!value) {
      return;
    }
    setPrompt(null);
    if (prompt.kind === 'mkdir') {
      await runAction('mkdir', () => onMkdir(value));
      return;
    }
    if (!prompt.entry) {
      return;
    }
    if (prompt.kind === 'rename') {
      await runAction('rename', () => onRename(prompt.entry!.path, value));
      return;
    }
    await runAction('chmod', () => onChmod(prompt.entry!.path, value));
  };

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: palette.surface,
          borderColor: palette.sessionSurfaceBorder,
        },
      ]}
    >
      <View style={styles.header}>
        <View style={styles.pathCopy}>
          <Text style={[styles.headerKicker, { color: palette.mutedText }]}>
            SFTP
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.pathText, { color: palette.text }]}
          >
            {currentPath}
          </Text>
        </View>
        {isSelectionMode ? (
          <View style={styles.selectionActions}>
            <Text style={[styles.selectionCount, { color: palette.accent }]}>
              선택 {selectedPaths.length}개
            </Text>
            <HeaderTextButton
              palette={palette}
              label="취소"
              disabled={busyAction !== null}
              onPress={clearSelection}
            />
            <IconButton
              palette={palette}
              icon="cloud-download-outline"
              label="다운로드"
              disabled={session.status !== 'connected' || busyAction !== null}
              onPress={() =>
                void runSelectedAction('download-selected', onDownloadEntries)
              }
            />
            <IconButton
              palette={palette}
              icon="copy-outline"
              label="복사"
              disabled={session.status !== 'connected' || busyAction !== null}
              onPress={() => {
                onCopy(selectedPaths);
                clearSelection();
              }}
            />
            <IconButton
              palette={palette}
              icon="trash-outline"
              label="삭제"
              disabled={session.status !== 'connected' || busyAction !== null}
              destructive
              onPress={() => {
                const paths = [...selectedPaths];
                Alert.alert('삭제', `선택한 ${paths.length}개 항목을 삭제할까요?`, [
                  { text: '취소', style: 'cancel' },
                  {
                    text: '삭제',
                    style: 'destructive',
                    onPress: () =>
                      void runSelectedAction('delete-selected', () =>
                        onDelete(paths),
                      ),
                  },
                ]);
              }}
            />
          </View>
        ) : (
          <View style={styles.headerActions}>
            <IconButton
              palette={palette}
              icon="arrow-up"
              label="상위 폴더"
              disabled={!canGoUp || busyAction !== null}
              onPress={() =>
                runAction('up', () => onNavigate(parentPath(currentPath)))
              }
            />
            <IconButton
              palette={palette}
              icon="refresh"
              label="새로고침"
              disabled={busyAction !== null}
              onPress={() => runAction('refresh', onRefresh)}
            />
            <IconButton
              palette={palette}
              icon="cloud-upload-outline"
              label="업로드"
              disabled={session.status !== 'connected' || busyAction !== null}
              onPress={() => runAction('upload', onUpload)}
            />
            <IconButton
              palette={palette}
              icon="folder-outline"
              label="새 폴더"
              disabled={session.status !== 'connected' || busyAction !== null}
              onPress={() => setPrompt({ kind: 'mkdir', value: '' })}
            />
          </View>
        )}
      </View>

      {session.errorMessage ? (
        <View
          style={[
            styles.banner,
            {
              borderColor: palette.sessionStatusError,
              backgroundColor: palette.surfaceAlt,
            },
          ]}
        >
          <Text style={[styles.bannerText, { color: palette.mutedText }]}>
            {session.errorMessage}
          </Text>
        </View>
      ) : null}

      {activeTransfers.length > 0 ? (
        <View
          style={[
            styles.transferStrip,
            {
              borderColor: palette.sessionToolbarBorder,
              backgroundColor: palette.surfaceAlt,
            },
          ]}
        >
          {activeTransfers.slice(-2).map(transfer => (
            <Text
              key={transfer.id}
              numberOfLines={1}
              style={[styles.transferText, { color: palette.mutedText }]}
            >
              {formatTransferDirection(transfer.direction)} ·{' '}
              {transfer.localName} ·{' '}
              {transfer.bytesTransferred.toLocaleString()} bytes
              {transfer.status === 'error' ? ` · ${transfer.errorMessage}` : ''}
            </Text>
          ))}
        </View>
      ) : null}

      {!isSelectionMode && copyBufferCount > 0 ? (
        <View
          style={[
            styles.pasteStrip,
            {
              borderColor: palette.accent,
              backgroundColor: palette.accentSoft,
            },
          ]}
        >
          <Text
            numberOfLines={1}
            style={[styles.pasteText, { color: palette.text }]}
          >
            복사한 항목 {copyBufferCount}개
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="붙여넣기"
            disabled={busyAction !== null}
            onPress={() => void runAction('paste', onPaste)}
            style={[styles.pasteButton, { backgroundColor: palette.accent }]}
          >
            <Text style={styles.pasteButtonText}>붙여넣기</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="복사 취소"
            disabled={busyAction !== null}
            onPress={onClearCopy}
            style={styles.pasteClearButton}
          >
            <Ionicons name="close" size={18} color={palette.mutedText} />
          </Pressable>
        </View>
      ) : null}

      {session.status === 'connecting' ? (
        <View style={styles.loading}>
          <ActivityIndicator size="small" color={palette.accent} />
          <Text style={[styles.loadingText, { color: palette.mutedText }]}>
            SFTP 연결 중입니다.
          </Text>
        </View>
      ) : (
        <FlatList
          data={entries}
          keyExtractor={entry => entry.path}
          contentContainerStyle={
            entries.length === 0 ? styles.emptyList : undefined
          }
          ListEmptyComponent={
            <Text style={[styles.emptyText, { color: palette.mutedText }]}>
              이 폴더가 비어 있습니다.
            </Text>
          }
          renderItem={({ item }) => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${item.name} ${item.isDirectory ? '폴더' : '파일'}`}
              onLongPress={() => toggleSelection(item.path)}
              onPress={() => {
                if (isSelectionMode) {
                  toggleSelection(item.path);
                  return;
                }
                if (item.isDirectory) {
                  void runAction(item.path, () => onNavigate(item.path));
                  return;
                }
                setActionEntry(item);
              }}
              style={[
                styles.row,
                selectedPathSet.has(item.path)
                  ? {
                      backgroundColor: palette.accentSoft,
                    }
                  : null,
                {
                  borderBottomColor: palette.sessionToolbarBorder,
                },
              ]}
            >
              {isSelectionMode ? (
                <Ionicons
                  name={
                    selectedPathSet.has(item.path)
                      ? 'checkmark-circle'
                      : 'ellipse-outline'
                  }
                  size={22}
                  color={
                    selectedPathSet.has(item.path)
                      ? palette.accent
                      : palette.mutedText
                  }
                />
              ) : null}
              <Ionicons
                name={item.isDirectory ? 'folder' : 'document-outline'}
                size={22}
                color={item.isDirectory ? palette.accent : palette.mutedText}
              />
              <View style={styles.rowCopy}>
                <Text
                  numberOfLines={1}
                  style={[styles.rowTitle, { color: palette.text }]}
                >
                  {item.name}
                </Text>
                <Text
                  numberOfLines={1}
                  style={[styles.rowMeta, { color: palette.mutedText }]}
                >
                  {formatEntryMeta(item)}
                </Text>
              </View>
              <Text style={[styles.rowDate, { color: palette.mutedText }]}>
                {formatModifiedTime(item.mtime)}
              </Text>
            </Pressable>
          )}
        />
      )}

      <EntryActionModal
        palette={palette}
        entry={actionEntry}
        onClose={() => setActionEntry(null)}
        onDismiss={flushActionAfterModalDismiss}
        onDownload={entry => {
          runAfterActionModalClose(() =>
            void runAction('download', () =>
              entry.isDirectory
                ? onDownloadEntries([entry.path])
                : onDownload(entry.path),
            ),
          );
        }}
        onRename={entry => {
          runAfterActionModalClose(() =>
            setPrompt({ kind: 'rename', entry, value: entry.name }),
          );
        }}
        onChmod={entry => {
          runAfterActionModalClose(() =>
            setPrompt({ kind: 'chmod', entry, value: '0644' }),
          );
        }}
        onDelete={entry => {
          runAfterActionModalClose(() =>
            Alert.alert('삭제', `${entry.name} 항목을 삭제할까요?`, [
              { text: '취소', style: 'cancel' },
              {
                text: '삭제',
                style: 'destructive',
                onPress: () =>
                  void runAction('delete', () => onDelete([entry.path])),
              },
            ]),
          );
        }}
      />

      <PromptModal
        palette={palette}
        prompt={prompt}
        onChange={value =>
          setPrompt(current => (current ? { ...current, value } : current))
        }
        onCancel={() => setPrompt(null)}
        onSubmit={() => void submitPrompt()}
      />
    </View>
  );
}

function IconButton({
  palette,
  icon,
  label,
  disabled,
  destructive,
  onPress,
}: {
  palette: MobilePalette;
  icon: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onPress: () => void;
}) {
  const activeColor = destructive ? palette.sessionStatusError : palette.accent;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.iconButton,
        {
          backgroundColor: disabled ? palette.surfaceAlt : palette.accentSoft,
          borderColor: disabled ? palette.sessionToolbarBorder : activeColor,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Ionicons
        name={icon}
        size={17}
        color={disabled ? palette.mutedText : activeColor}
      />
    </Pressable>
  );
}

function HeaderTextButton({
  palette,
  label,
  disabled,
  onPress,
}: {
  palette: MobilePalette;
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.headerTextButton,
        {
          borderColor: palette.sessionToolbarBorder,
          backgroundColor: palette.surfaceAlt,
          opacity: disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text style={[styles.headerTextButtonText, { color: palette.mutedText }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function EntryActionModal({
  palette,
  entry,
  onClose,
  onDismiss,
  onDownload,
  onRename,
  onChmod,
  onDelete,
}: {
  palette: MobilePalette;
  entry: FileEntry | null;
  onClose: () => void;
  onDismiss: () => void;
  onDownload: (entry: FileEntry) => void;
  onRename: (entry: FileEntry) => void;
  onChmod: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;
}) {
  if (!entry) {
    return null;
  }
  return (
    <Modal
      transparent
      animationType="fade"
      visible
      onDismiss={onDismiss}
      onRequestClose={onClose}
    >
      <Pressable
        style={[styles.modalOverlay, { backgroundColor: palette.overlay }]}
        onPress={onClose}
      >
        <View style={[styles.modalCard, { backgroundColor: palette.surface }]}>
          <Text style={[styles.modalTitle, { color: palette.text }]}>
            {entry.name}
          </Text>
          <ActionRow
            palette={palette}
            icon="cloud-download-outline"
            label="Download"
            onPress={() => onDownload(entry)}
          />
          <ActionRow
            palette={palette}
            icon="pencil"
            label="Rename"
            onPress={() => onRename(entry)}
          />
          <ActionRow
            palette={palette}
            icon="key-outline"
            label="Chmod"
            onPress={() => onChmod(entry)}
          />
          <ActionRow
            palette={palette}
            icon="trash-outline"
            label="Delete"
            destructive
            onPress={() => onDelete(entry)}
          />
        </View>
      </Pressable>
    </Modal>
  );
}

function ActionRow({
  palette,
  icon,
  label,
  destructive,
  onPress,
}: {
  palette: MobilePalette;
  icon: string;
  label: string;
  destructive?: boolean;
  onPress: () => void;
}) {
  const color = destructive ? palette.sessionStatusError : palette.text;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={styles.actionRow}
    >
      <Ionicons name={icon} size={20} color={color} />
      <Text style={[styles.actionText, { color }]}>{label}</Text>
    </Pressable>
  );
}

function PromptModal({
  palette,
  prompt,
  onChange,
  onCancel,
  onSubmit,
}: {
  palette: MobilePalette;
  prompt: PromptState | null;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  if (!prompt) {
    return null;
  }
  const title =
    prompt.kind === 'mkdir'
      ? '새 폴더'
      : prompt.kind === 'rename'
        ? '이름 변경'
        : '권한 변경';
  const placeholder = prompt.kind === 'chmod' ? '0644' : '이름';
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onCancel}>
      <View style={[styles.modalOverlay, { backgroundColor: palette.overlay }]}>
        <View style={[styles.promptCard, { backgroundColor: palette.surface }]}>
          <Text style={[styles.modalTitle, { color: palette.text }]}>
            {title}
          </Text>
          <TextInput
            value={prompt.value}
            onChangeText={onChange}
            placeholder={placeholder}
            placeholderTextColor={palette.mutedText}
            autoCapitalize="none"
            autoCorrect={false}
            style={[
              styles.promptInput,
              {
                color: palette.text,
                backgroundColor: palette.surfaceAlt,
                borderColor: palette.sessionToolbarBorder,
              },
            ]}
          />
          <View style={styles.promptActions}>
            <Pressable style={styles.promptButton} onPress={onCancel}>
              <Text
                style={[styles.promptButtonText, { color: palette.mutedText }]}
              >
                취소
              </Text>
            </Pressable>
            <Pressable
              style={[styles.promptButton, { backgroundColor: palette.accent }]}
              onPress={onSubmit}
            >
              <Text style={[styles.promptButtonText, { color: '#FFFFFF' }]}>
                확인
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function formatTransferDirection(
  direction: MobileSftpTransferRecord['direction'],
): string {
  if (direction === 'download') {
    return 'Download';
  }
  if (direction === 'copy') {
    return 'Copy';
  }
  return 'Upload';
}

function formatEntryMeta(entry: FileEntry): string {
  const parts = [formatUnixPermissions(entry)].filter(Boolean);
  if (!entry.isDirectory) {
    parts.push(`${entry.size.toLocaleString()} bytes`);
  }
  return parts.join(' · ');
}

function formatUnixPermissions(entry: FileEntry): string {
  if (!entry.permissions) {
    return '';
  }
  const parsed = Number.parseInt(entry.permissions, 8);
  if (!Number.isFinite(parsed)) {
    return '';
  }
  const typePrefix =
    entry.kind === 'folder' ? 'd' : entry.kind === 'symlink' ? 'l' : '-';
  const permissionBits = parsed & 0o777;
  const specialBits = parsed & 0o7000;
  const chars = [
    permissionBits & 0o400 ? 'r' : '-',
    permissionBits & 0o200 ? 'w' : '-',
    permissionBits & 0o100 ? 'x' : '-',
    permissionBits & 0o040 ? 'r' : '-',
    permissionBits & 0o020 ? 'w' : '-',
    permissionBits & 0o010 ? 'x' : '-',
    permissionBits & 0o004 ? 'r' : '-',
    permissionBits & 0o002 ? 'w' : '-',
    permissionBits & 0o001 ? 'x' : '-',
  ];

  if (specialBits & 0o4000) {
    chars[2] = chars[2] === 'x' ? 's' : 'S';
  }
  if (specialBits & 0o2000) {
    chars[5] = chars[5] === 'x' ? 's' : 'S';
  }
  if (specialBits & 0o1000) {
    chars[8] = chars[8] === 'x' ? 't' : 'T';
  }

  return `${typePrefix}${chars.join('')}`;
}

function formatModifiedTime(value: string): string {
  if (!value) {
    return '';
  }
  const numericValue = Number(value);
  const timestamp = Number.isFinite(numericValue)
    ? numericValue < 1_000_000_000_000
      ? numericValue * 1000
      : numericValue
    : Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return '';
  }

  const date = new Date(timestamp);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(
    date.getDate(),
  )} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function parentPath(path: string): string {
  const normalized = path.replace(/\/+$/, '');
  const slashIndex = normalized.lastIndexOf('/');
  if (slashIndex <= 0) {
    return normalized.startsWith('/') ? '/' : '.';
  }
  return normalized.slice(0, slashIndex);
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    marginHorizontal: 2,
    marginTop: 4,
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  pathCopy: {
    flex: 1,
    gap: 2,
  },
  headerKicker: {
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 1.6,
  },
  pathText: {
    fontSize: 15,
    fontWeight: '800',
  },
  headerActions: {
    flexDirection: 'row',
    gap: 6,
  },
  selectionActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  selectionCount: {
    fontSize: 12,
    fontWeight: '900',
  },
  iconButton: {
    width: 34,
    height: 34,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerTextButton: {
    minWidth: 42,
    height: 34,
    borderRadius: 11,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  headerTextButtonText: {
    fontSize: 12,
    fontWeight: '900',
  },
  banner: {
    marginHorizontal: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  bannerText: {
    fontSize: 12,
    lineHeight: 17,
  },
  transferStrip: {
    marginHorizontal: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 7,
    gap: 3,
  },
  transferText: {
    fontSize: 11,
    fontWeight: '600',
  },
  pasteStrip: {
    marginHorizontal: 10,
    marginBottom: 8,
    borderWidth: 1,
    borderRadius: 13,
    paddingHorizontal: 10,
    paddingVertical: 7,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pasteText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '800',
  },
  pasteButton: {
    minHeight: 30,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 10,
  },
  pasteButtonText: {
    color: '#FFFFFF',
    fontSize: 12,
    fontWeight: '900',
  },
  pasteClearButton: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingText: {
    fontSize: 13,
    fontWeight: '700',
  },
  emptyList: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 20,
  },
  emptyText: {
    fontSize: 13,
    fontWeight: '700',
  },
  row: {
    minHeight: 58,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  rowCopy: {
    flex: 1,
    gap: 3,
  },
  rowTitle: {
    fontSize: 14,
    fontWeight: '800',
  },
  rowMeta: {
    fontSize: 11,
    fontWeight: '600',
  },
  rowDate: {
    minWidth: 76,
    textAlign: 'right',
    fontSize: 11,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  modalCard: {
    borderRadius: 22,
    paddingVertical: 12,
    paddingHorizontal: 14,
    gap: 4,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '900',
    marginBottom: 6,
  },
  actionRow: {
    minHeight: 48,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  actionText: {
    fontSize: 16,
    fontWeight: '800',
  },
  promptCard: {
    borderRadius: 22,
    padding: 16,
    gap: 12,
  },
  promptInput: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
    fontWeight: '700',
  },
  promptActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  promptButton: {
    minWidth: 76,
    minHeight: 42,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 12,
  },
  promptButtonText: {
    fontSize: 14,
    fontWeight: '800',
  },
});
