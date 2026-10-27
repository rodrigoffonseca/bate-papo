import { Link, Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { errorMessage, formatTime } from '@/components/format';
import { ImageContent, VideoContent, VoiceContent, formatDuration } from '@/components/media';
import { Banner, Screen, Txt } from '@/components/ui';
import type { Message } from '@/core/history';
import { useAppState, useHistoryQuery, useService } from '@/platform/app';
import { pickFromGallery, prepareAsset, takeWithCamera } from '@/platform/pick-media';
import { useVoiceRecorder } from '@/platform/voice';
import { spacing, useTheme } from '@/theme';

const STATUS_ICON: Record<Message['status'], string> = { sending: '🕓', sent: '✓', failed: '⚠️', received: '' };
const STATUS_LABEL: Record<Message['status'], string> = {
  sending: 'enviando',
  sent: 'enviada',
  failed: 'não enviada, toque para tentar de novo',
  received: '',
};

function describe(m: Message): string {
  if (m.kind === 'image') return m.text ? `Foto: ${m.text}` : 'Foto';
  if (m.kind === 'video') return `Vídeo de ${formatDuration(m.attachment?.durationMs)}${m.text ? `: ${m.text}` : ''}`;
  if (m.kind === 'voice') return `Mensagem de voz de ${formatDuration(m.attachment?.durationMs)}`;
  return m.text ?? '';
}

/** Aviso da conversa, como "Maria entrou no grupo". */
function Notice({ m }: { m: Message }) {
  const t = useTheme();
  return (
    <View
      accessible
      accessibilityLabel={`${m.text}. ${formatTime(m.sentAt)}`}
      style={{
        alignSelf: 'center',
        maxWidth: '85%',
        backgroundColor: t.surface,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 6,
        marginVertical: 6,
      }}
    >
      <Txt muted style={{ fontSize: 13, textAlign: 'center' }}>
        {m.text}
      </Txt>
    </View>
  );
}

function Bubble({ m, showSender, onRetry }: { m: Message; showSender: boolean; onRetry: (id: string) => void }) {
  const t = useTheme();
  if (m.kind === 'system') return <Notice m={m} />;
  const failed = m.status === 'failed';
  const media = m.kind === 'image' || m.kind === 'video' || m.kind === 'voice';
  const sender = m.outgoing ? 'Você' : (m.senderName ?? 'Contato');
  return (
    <View
      accessible={!media}
      accessibilityLabel={`${sender}: ${describe(m)}. ${formatTime(m.sentAt)}${
        m.outgoing ? `, ${STATUS_LABEL[m.status]}` : ''
      }`}
      style={{
        alignSelf: m.outgoing ? 'flex-end' : 'flex-start',
        maxWidth: '85%',
        backgroundColor: m.outgoing ? t.bubbleOut : t.bubbleIn,
        borderRadius: 16,
        borderBottomRightRadius: m.outgoing ? 4 : 16,
        borderBottomLeftRadius: m.outgoing ? 16 : 4,
        padding: media && m.kind !== 'voice' ? 4 : undefined,
        paddingHorizontal: media && m.kind !== 'voice' ? 4 : 12,
        paddingVertical: media && m.kind !== 'voice' ? 4 : 8,
        marginVertical: 2,
        borderWidth: failed ? 1 : 0,
        borderColor: t.danger,
        gap: 4,
      }}
    >
      {showSender && !m.outgoing && (
        <Txt
          numberOfLines={1}
          style={{ fontSize: 13, fontWeight: '700', color: t.primary, paddingHorizontal: media && m.kind !== 'voice' ? 8 : 0 }}
        >
          {sender}
        </Txt>
      )}
      {m.kind === 'image' && <ImageContent m={m} />}
      {m.kind === 'video' && <VideoContent m={m} />}
      {m.kind === 'voice' && <VoiceContent m={m} />}
      {m.text && m.kind !== 'voice' ? (
        <Txt selectable style={media ? { paddingHorizontal: 8 } : undefined}>
          {m.text}
        </Txt>
      ) : null}
      <Pressable
        disabled={!failed}
        onPress={() => onRetry(m.id)}
        accessibilityRole={failed ? 'button' : undefined}
        accessibilityLabel={failed ? 'Mensagem não enviada. Tentar de novo' : undefined}
        style={{ alignSelf: 'flex-end', paddingHorizontal: media && m.kind !== 'voice' ? 8 : 0 }}
      >
        <Txt muted style={{ fontSize: 11, color: failed ? t.danger : undefined }}>
          {failed ? 'Não enviada · tocar para tentar ' : ''}
          {formatTime(m.sentAt)} {m.outgoing ? STATUS_ICON[m.status] : ''}
        </Txt>
      </Pressable>
    </View>
  );
}

function RoundButton({
  label,
  icon,
  onPress,
  disabled,
  filled,
}: {
  label: string;
  icon: string;
  onPress: () => void;
  disabled?: boolean;
  filled?: boolean;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: filled ? t.primary : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
      })}
    >
      <Txt style={{ color: filled ? t.onPrimary : t.primary, fontSize: 20, fontWeight: '700' }}>{icon}</Txt>
    </Pressable>
  );
}

export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const service = useService();
  const { identityAlert, online } = useAppState();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [preparing, setPreparing] = useState(false);
  const voice = useVoiceRecorder();

  const conversation = useHistoryQuery((h) => h.getConversation(id), [id]);
  const messages = useHistoryQuery((h) => h.listMessages(id), [id]);
  const groupId = conversation?.kind === 'group' ? conversation.peerId : null;
  const group = useHistoryQuery((h) => (groupId ? h.getGroup(groupId) : Promise.resolve(null)), [groupId]);

  useFocusEffect(
    useCallback(() => {
      service.setActiveConversation(id);
      return () => service.setActiveConversation(null);
    }, [service, id]),
  );

  const send = () => {
    if (!conversation || !text.trim()) return;
    service.sendText(conversation.id, text).catch((err) => Alert.alert('Não foi possível enviar', errorMessage(err)));
    setText('');
  };

  /** Lê, prepara e envia a foto/vídeo; a legenda é o texto digitado. */
  const sendPicked = async (source: 'camera' | 'gallery') => {
    if (!conversation) return;
    try {
      const asset = source === 'camera' ? await takeWithCamera() : await pickFromGallery();
      if (!asset) return;
      setPreparing(true);
      const input = await prepareAsset(asset);
      const caption = text.trim();
      setText('');
      await service.sendMedia(conversation.id, { ...input, ...(caption && { caption }) });
    } catch (err) {
      Alert.alert('Não foi possível enviar', errorMessage(err));
    } finally {
      setPreparing(false);
    }
  };

  const attach = () =>
    Alert.alert('Enviar foto ou vídeo', undefined, [
      { text: 'Câmera', onPress: () => void sendPicked('camera') },
      { text: 'Galeria', onPress: () => void sendPicked('gallery') },
      { text: 'Cancelar', style: 'cancel' },
    ]);

  const startVoice = async () => {
    try {
      await voice.start();
    } catch (err) {
      Alert.alert('Não foi possível gravar', errorMessage(err));
    }
  };

  const finishVoice = async () => {
    if (!conversation) return;
    try {
      const input = await voice.stop();
      if (input) await service.sendMedia(conversation.id, input);
    } catch (err) {
      Alert.alert('Não foi possível enviar o áudio', errorMessage(err));
    }
  };

  // Troca de chave de segurança do contato ou de alguém do grupo.
  const keyChangedFor = groupId
    ? group?.members.find((m) => m.userId === identityAlert?.userId)?.name
    : identityAlert?.userId === conversation?.peerId
      ? conversation?.title
      : undefined;

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: conversation?.title ?? '',
          headerRight: groupId
            ? () => (
                <Link href={{ pathname: '/grupo/[id]', params: { id: groupId } }} accessibilityLabel="Dados do grupo">
                  <Txt style={{ color: t.primary, fontSize: 22 }}>ⓘ</Txt>
                </Link>
              )
            : undefined,
        }}
      />
      {keyChangedFor && (
        <Banner>
          A chave de segurança de {keyChangedFor} mudou. Isso acontece quando a pessoa reinstala o app ou troca de
          celular.
        </Banner>
      )}
      {!online && <Banner>Sem conexão. As mensagens serão enviadas quando você reconectar.</Banner>}
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
      >
        <FlatList
          inverted
          data={messages ?? []}
          keyExtractor={(m) => `${m.senderId}:${m.id}`}
          renderItem={({ item }) => (
            <Bubble m={item} showSender={!!groupId} onRetry={(mid) => void service.retry(mid)} />
          )}
          contentContainerStyle={{ padding: spacing.sm }}
          ListFooterComponent={
            <View style={{ padding: spacing.md, alignItems: 'center' }}>
              <Txt muted style={{ fontSize: 12, textAlign: 'center' }}>
                🔒 Mensagens, fotos, vídeos e áudios protegidos com criptografia de ponta a ponta.
              </Txt>
            </View>
          }
        />
        {conversation && !conversation.active ? (
          <View
            style={{
              padding: spacing.md,
              paddingBottom: Math.max(insets.bottom, spacing.md),
              borderTopWidth: 1,
              borderTopColor: t.border,
            }}
          >
            <Txt muted style={{ textAlign: 'center' }}>
              Você não faz mais parte deste grupo.
            </Txt>
          </View>
        ) : (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-end',
              gap: spacing.xs,
              padding: spacing.sm,
              paddingBottom: Math.max(insets.bottom, spacing.sm),
              borderTopWidth: 1,
              borderTopColor: t.border,
              backgroundColor: t.background,
            }}
          >
            {voice.recording ? (
              <>
                <RoundButton label="Descartar áudio" icon="🗑" onPress={() => void voice.cancel()} />
                <View
                  accessibilityLiveRegion="polite"
                  style={{ flex: 1, height: 44, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.sm }}
                >
                  <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.danger }} />
                  <Txt>Gravando {formatDuration(voice.durationMs)}</Txt>
                </View>
                <RoundButton label="Enviar áudio" icon="➤" filled onPress={() => void finishVoice()} />
              </>
            ) : (
              <>
                {preparing ? (
                  <ActivityIndicator style={{ width: 44, height: 44 }} color={t.primary} />
                ) : (
                  <RoundButton label="Enviar foto ou vídeo" icon="📎" onPress={attach} />
                )}
                <TextInput
                  accessibilityLabel="Mensagem"
                  placeholder={preparing ? 'Preparando arquivo…' : 'Mensagem'}
                  placeholderTextColor={t.textMuted}
                  value={text}
                  onChangeText={setText}
                  multiline
                  maxLength={4000}
                  style={{
                    flex: 1,
                    maxHeight: 140,
                    color: t.text,
                    backgroundColor: t.surface,
                    borderRadius: 20,
                    paddingHorizontal: 16,
                    paddingTop: 10,
                    paddingBottom: 10,
                    fontSize: 16,
                  }}
                />
                {text.trim() ? (
                  <RoundButton label="Enviar" icon="➤" filled onPress={send} />
                ) : (
                  <RoundButton label="Gravar mensagem de voz" icon="🎤" filled onPress={() => void startVoice()} />
                )}
              </>
            )}
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}
