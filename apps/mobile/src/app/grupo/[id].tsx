import { Link, Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { errorMessage } from '@/components/format';
import { Avatar, Button, Field, Txt } from '@/components/ui';
import type { GroupMemberInfo } from '@/core/history';
import { useAppState, useHistoryQuery, useService } from '@/platform/app';
import { spacing, useTheme } from '@/theme';

/** Dados do grupo: nome, participantes e administração. */
export default function Grupo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const service = useService();
  const router = useRouter();
  const t = useTheme();
  const { me } = useAppState();
  const group = useHistoryQuery((h) => h.getGroup(id), [id]);
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (group === undefined) return null;
  if (!group) {
    return (
      <View style={{ padding: spacing.lg }}>
        <Txt muted>Grupo não encontrado.</Txt>
      </View>
    );
  }

  const iAmAdmin = group.active && group.members.some((m) => m.userId === me?.id && m.role === 'admin');

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      Alert.alert('Não foi possível concluir', errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const saveName = () =>
    run(async () => {
      await service.renameGroup(group.id, name ?? group.name);
      setName(null);
    });

  const memberOptions = (m: GroupMemberInfo) => {
    if (m.userId === me?.id) return;
    router.push({ pathname: '/contato/[id]', params: { id: m.userId, grupo: group.id } });
  };

  const leave = () =>
    Alert.alert('Sair do grupo?', 'Você deixa de receber as mensagens. O histórico continua neste aparelho.', [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: 'Sair',
        style: 'destructive',
        onPress: () => void run(() => service.leaveGroup(group.id)),
      },
    ]);

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }} keyboardShouldPersistTaps="handled">
      <Stack.Screen options={{ title: group.name }} />
      <View style={{ alignItems: 'center', gap: spacing.sm }}>
        <Avatar name={group.name} seed={group.id} size={80} />
        <Txt muted>
          {group.active ? `${group.members.length} participantes` : 'Você não faz mais parte deste grupo'}
        </Txt>
      </View>

      {iAmAdmin && (
        <View style={{ gap: spacing.sm }}>
          <Field label="Nome do grupo" value={name ?? group.name} onChangeText={setName} maxLength={64} />
          {name !== null && name.trim() !== group.name && (
            <Button title="Salvar nome" onPress={() => void saveName()} loading={busy} disabled={!name.trim()} />
          )}
        </View>
      )}

      {group.active && (
        <View style={{ gap: spacing.xs }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <Txt muted style={{ fontSize: 14 }}>
              Participantes
            </Txt>
            {iAmAdmin && (
              <Link
                href={{
                  pathname: '/grupo/adicionar',
                  params: { id: group.id },
                }}
                accessibilityRole="button"
              >
                <Txt style={{ color: t.primary, fontWeight: '600' }}>＋ Adicionar</Txt>
              </Link>
            )}
          </View>
          {group.members.map((m) => (
            <Pressable
              key={m.userId}
              onPress={() => memberOptions(m)}
              disabled={m.userId === me?.id}
              accessibilityRole="button"
              accessibilityLabel={`${m.name}${m.role === 'admin' ? ', administrador' : ''}`}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.md,
                paddingVertical: spacing.sm,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Avatar name={m.name} seed={m.userId} size={40} />
              <Txt style={{ flex: 1 }} numberOfLines={1}>
                {m.name}
              </Txt>
              {m.role === 'admin' && (
                <Txt muted style={{ fontSize: 12 }}>
                  admin
                </Txt>
              )}
            </Pressable>
          ))}
        </View>
      )}

      <Txt muted style={{ fontSize: 13 }}>
        🔒 Cada mensagem é cifrada separadamente para cada participante. Quando alguém entra ou sai, todos veem o aviso
        na conversa, e quem entra não recebe as mensagens anteriores.
      </Txt>

      {group.active && <Button variant="danger" title="Sair do grupo" onPress={leave} disabled={busy} />}
    </ScrollView>
  );
}
