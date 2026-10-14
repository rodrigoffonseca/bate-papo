import { Link, Stack, useRouter } from 'expo-router';
import { FlatList, Pressable, View } from 'react-native';

import { formatListDate } from '@/components/format';
import { Avatar, Banner, Button, Screen, Txt } from '@/components/ui';
import type { Conversation } from '@/core/history';
import { useAppState, useHistoryQuery, useService } from '@/platform/app';
import { spacing, useTheme } from '@/theme';

function Row({ c }: { c: Conversation }) {
  const t = useTheme();
  return (
    <Link href={{ pathname: '/chat/[id]', params: { id: c.id } }} asChild>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${c.title}${c.unread ? `, ${c.unread} não lidas` : ''}`}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.md,
          paddingHorizontal: spacing.md,
          paddingVertical: 12,
          backgroundColor: pressed ? t.surface : t.background,
        })}
      >
        <Avatar name={c.title} seed={c.peerId} />
        <View style={{ flex: 1, gap: 2 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm }}>
            <Txt numberOfLines={1} style={{ flex: 1, fontWeight: '600' }}>
              {c.title}
            </Txt>
            <Txt muted style={{ fontSize: 12, color: c.unread ? t.primary : t.textMuted }}>
              {c.lastText !== null ? formatListDate(c.lastAt) : ''}
            </Txt>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Txt muted numberOfLines={1} style={{ flex: 1, fontSize: 14 }}>
              {c.lastText ?? 'Nova conversa'}
            </Txt>
            {c.unread > 0 && (
              <View style={{ backgroundColor: t.primary, borderRadius: 10, minWidth: 20, paddingHorizontal: 6, alignItems: 'center' }}>
                <Txt style={{ color: t.onPrimary, fontSize: 12, fontWeight: '700' }}>{c.unread}</Txt>
              </View>
            )}
          </View>
        </View>
      </Pressable>
    </Link>
  );
}

export default function Conversas() {
  const t = useTheme();
  const router = useRouter();
  const service = useService();
  const { online, accountAlerts, pinReminderDue } = useAppState();
  const conversations = useHistoryQuery((h) => h.listConversations(), []);

  return (
    <Screen>
      <Stack.Screen
        options={{
          headerRight: () => (
            <View style={{ flexDirection: 'row', gap: spacing.md }}>
              <Link href="/nova" accessibilityLabel="Nova conversa">
                <Txt style={{ color: t.primary, fontSize: 26, lineHeight: 28 }}>＋</Txt>
              </Link>
              <Link href="/ajustes" accessibilityLabel="Ajustes">
                <Txt style={{ color: t.primary, fontSize: 22, lineHeight: 28 }}>⚙︎</Txt>
              </Link>
            </View>
          ),
        }}
      />
      {accountAlerts.length > 0 && (
        <View style={{ backgroundColor: t.warningBg, padding: spacing.md, gap: spacing.sm }} accessibilityLiveRegion="assertive">
          <Txt style={{ color: t.warningText, fontWeight: '700' }}>⚠️ Tentativa de acesso à sua conta</Txt>
          <Txt style={{ color: t.warningText, fontSize: 14 }}>
            {accountAlerts.some((a) => a.kind === 'registration_attempt')
              ? 'Alguém confirmou o código SMS do seu número em outro celular e foi barrado pelo seu PIN. '
              : 'Alguém errou o seu PIN em outro celular. '}
            Se não foi você, seu chip pode ter sido clonado: procure sua operadora. Nunca informe seu PIN nem o código
            de recuperação a ninguém.
          </Txt>
          <Button variant="ghost" title="Entendi" onPress={() => void service.dismissAccountAlerts()} />
        </View>
      )}
      {pinReminderDue && accountAlerts.length === 0 && (
        <Link href="/lembrete-pin" asChild>
          <Pressable accessibilityRole="button">
            <Banner>🔑 Confirme seu PIN para não esquecê-lo. Toque aqui.</Banner>
          </Pressable>
        </Link>
      )}
      {!online && <Banner>Conectando…</Banner>}
      <FlatList
        data={conversations ?? []}
        keyExtractor={(c) => c.id}
        renderItem={({ item }) => <Row c={item} />}
        ItemSeparatorComponent={() => <View style={{ height: 1, backgroundColor: t.border, marginLeft: 76 }} />}
        ListEmptyComponent={
          conversations ? (
            <View style={{ padding: spacing.xl, gap: spacing.md, alignItems: 'center' }}>
              <Txt muted style={{ textAlign: 'center' }}>
                Nenhuma conversa ainda. Comece uma pelo nome de usuário de alguém.
              </Txt>
              <Button title="Nova conversa" onPress={() => router.push('/nova')} />
            </View>
          ) : null
        }
      />
    </Screen>
  );
}
