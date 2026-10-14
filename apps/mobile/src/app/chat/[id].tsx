import { Stack, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, KeyboardAvoidingView, Platform, Pressable, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { formatTime } from '@/components/format';
import { Banner, Screen, Txt } from '@/components/ui';
import type { Message } from '@/core/history';
import { useAppState, useHistoryQuery, useService } from '@/platform/app';
import { spacing, useTheme } from '@/theme';

const STATUS_ICON: Record<Message['status'], string> = { sending: '🕓', sent: '✓', failed: '⚠️', received: '' };
const STATUS_LABEL: Record<Message['status'], string> = {
  sending: 'enviando',
  sent: 'enviada',
  failed: 'não enviada, toque para tentar de novo',
  received: '',
};

/** Fotos e áudios chegam na próxima versão; por enquanto, um aviso no lugar. */
function messageText(m: Message): string {
  if (m.kind === 'image') return `📷 Foto${m.text ? `: ${m.text}` : ''} (abra numa versão mais nova do app)`;
  if (m.kind === 'voice') return '🎤 Mensagem de voz (abra numa versão mais nova do app)';
  return m.text ?? '';
}

function Bubble({ m, onRetry }: { m: Message; onRetry: (id: string) => void }) {
  const t = useTheme();
  const failed = m.status === 'failed';
  return (
    <Pressable
      disabled={!failed}
      onPress={() => onRetry(m.id)}
      accessibilityRole={failed ? 'button' : 'text'}
      accessibilityLabel={`${m.outgoing ? 'Você' : 'Contato'}: ${messageText(m)}. ${formatTime(m.sentAt)}${
        m.outgoing ? `, ${STATUS_LABEL[m.status]}` : ''
      }`}
      style={{
        alignSelf: m.outgoing ? 'flex-end' : 'flex-start',
        maxWidth: '80%',
        backgroundColor: m.outgoing ? t.bubbleOut : t.bubbleIn,
        borderRadius: 16,
        borderBottomRightRadius: m.outgoing ? 4 : 16,
        borderBottomLeftRadius: m.outgoing ? 16 : 4,
        paddingHorizontal: 12,
        paddingVertical: 8,
        marginVertical: 2,
        borderWidth: failed ? 1 : 0,
        borderColor: t.danger,
      }}
    >
      <Txt selectable>{messageText(m)}</Txt>
      <Txt muted style={{ fontSize: 11, alignSelf: 'flex-end', marginTop: 2 }}>
        {formatTime(m.sentAt)} {m.outgoing ? STATUS_ICON[m.status] : ''}
      </Txt>
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

  const conversation = useHistoryQuery((h) => h.getConversation(id), [id]);
  const messages = useHistoryQuery((h) => h.listMessages(id), [id]);

  useFocusEffect(
    useCallback(() => {
      service.setActiveConversation(id);
      return () => service.setActiveConversation(null);
    }, [service, id]),
  );

  const send = () => {
    if (!conversation || !text.trim()) return;
    void service.sendText(conversation.peerId, text);
    setText('');
  };

  const keyChanged = conversation && identityAlert?.userId === conversation.peerId;

  return (
    <Screen>
      <Stack.Screen options={{ title: conversation?.title ?? '' }} />
      {keyChanged && (
        <Banner>
          A chave de segurança de {conversation.title} mudou. Isso acontece quando a pessoa reinstala o app ou troca de
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
          renderItem={({ item }) => <Bubble m={item} onRetry={(mid) => void service.retry(mid)} />}
          contentContainerStyle={{ padding: spacing.sm }}
          ListFooterComponent={
            <View style={{ padding: spacing.md, alignItems: 'center' }}>
              <Txt muted style={{ fontSize: 12, textAlign: 'center' }}>
                🔒 Mensagens protegidas com criptografia de ponta a ponta.
              </Txt>
            </View>
          }
        />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            gap: spacing.sm,
            padding: spacing.sm,
            paddingBottom: Math.max(insets.bottom, spacing.sm),
            borderTopWidth: 1,
            borderTopColor: t.border,
            backgroundColor: t.background,
          }}
        >
          <TextInput
            accessibilityLabel="Mensagem"
            placeholder="Mensagem"
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
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Enviar"
            disabled={!text.trim()}
            onPress={send}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: t.primary,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: !text.trim() ? 0.4 : pressed ? 0.8 : 1,
            })}
          >
            <Txt style={{ color: t.onPrimary, fontSize: 20, fontWeight: '700' }}>➤</Txt>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
