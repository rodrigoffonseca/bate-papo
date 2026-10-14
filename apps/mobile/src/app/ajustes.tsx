import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';

import { errorMessage } from '@/components/format';
import { Avatar, Button, Screen, Title, Txt } from '@/components/ui';
import { useAppState, useService } from '@/platform/app';
import { SERVER_URL } from '@/platform/config';
import { spacing, useTheme } from '@/theme';

export default function Ajustes() {
  const service = useService();
  const { me } = useAppState();
  const t = useTheme();
  const [busy, setBusy] = useState(false);
  const name = me?.display_name ?? me?.username ?? '';

  const confirm = (title: string, message: string, action: string, run: () => Promise<void>) =>
    Alert.alert(title, message, [
      { text: 'Cancelar', style: 'cancel' },
      {
        text: action,
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await run();
          } catch (err) {
            Alert.alert('Não foi possível concluir', errorMessage(err));
            setBusy(false);
          }
        },
      },
    ]);

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ alignItems: 'center', gap: spacing.sm }}>
          <Avatar name={name} seed={me?.id ?? ''} size={80} />
          <Title style={{ fontSize: 22 }}>{name}</Title>
          {me?.username ? <Txt muted>@{me.username}</Txt> : null}
        </View>

        <View style={{ backgroundColor: t.surface, borderRadius: 12, padding: spacing.md, gap: spacing.xs }}>
          <Txt style={{ fontWeight: '600' }}>🔒 Privacidade</Txt>
          <Txt muted style={{ fontSize: 14 }}>
            Suas conversas ficam só neste aparelho, num banco de dados cifrado. O servidor apaga cada mensagem assim que
            ela é entregue.
          </Txt>
          <Txt muted style={{ fontSize: 12 }}>Servidor: {SERVER_URL}</Txt>
        </View>

        <Button
          variant="ghost"
          title="Sair"
          loading={busy}
          onPress={() =>
            confirm(
              'Sair do Bate-Papo?',
              'As conversas deste aparelho serão apagadas. Elas não ficam guardadas no servidor.',
              'Sair',
              () => service.logout(),
            )
          }
        />
        <Button
          variant="danger"
          title="Apagar minha conta"
          disabled={busy}
          onPress={() =>
            confirm(
              'Apagar sua conta?',
              'Sua conta, seu nome de usuário e seus grupos serão apagados do servidor, e as conversas deste aparelho também. Não dá para desfazer.',
              'Apagar conta',
              () => service.deleteAccount(),
            )
          }
        />
      </ScrollView>
    </Screen>
  );
}
