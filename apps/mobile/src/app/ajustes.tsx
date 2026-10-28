import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Alert, Linking, ScrollView, Switch, View } from 'react-native';

import { errorMessage } from '@/components/format';
import { Avatar, Button, Screen, Title, Txt } from '@/components/ui';
import type { NotificationsState } from '@/core/service';
import { useAppState, useService } from '@/platform/app';
import { SERVER_URL } from '@/platform/config';
import { spacing, useTheme } from '@/theme';

const NOTIFICATIONS_TEXT: Record<NotificationsState, string> = {
  on: 'Você é avisado quando chega mensagem com o app fechado. O aviso diz só "Você tem novas mensagens": nem o texto, nem quem enviou passam pelo Google ou pela Apple.',
  off: 'Desligadas. As mensagens aparecem quando você abrir o app.',
  denied: 'Bloqueadas nos ajustes do celular. Libere as notificações do Bate-Papo para ser avisado de mensagens novas.',
  unavailable: 'Este servidor ou esta versão do app não envia notificações. As mensagens aparecem quando você abrir o app.',
};

export default function Ajustes() {
  const service = useService();
  const router = useRouter();
  const { me, notifications } = useAppState();
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

        <View style={{ backgroundColor: t.surface, borderRadius: 12, padding: spacing.md, gap: spacing.sm }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Txt style={{ fontWeight: '600' }}>🔔 Notificações</Txt>
            <Switch
              accessibilityLabel="Notificações"
              value={notifications === 'on'}
              disabled={notifications === 'unavailable'}
              onValueChange={(on) => void service.setNotifications(on).catch(() => undefined)}
            />
          </View>
          <Txt muted style={{ fontSize: 14 }}>
            {NOTIFICATIONS_TEXT[notifications]}
          </Txt>
          {notifications === 'denied' && (
            <Button variant="ghost" title="Abrir ajustes do celular" onPress={() => void Linking.openSettings()} />
          )}
        </View>

        <View style={{ backgroundColor: t.surface, borderRadius: 12, padding: spacing.md, gap: spacing.sm }}>
          <Txt style={{ fontWeight: '600' }}>💾 Armazenamento</Txt>
          <Txt muted style={{ fontSize: 14 }}>
            Veja quanto espaço fotos, vídeos e áudios ocupam e apague o que não precisa mais.
          </Txt>
          <Button variant="ghost" title="Gerenciar armazenamento" onPress={() => router.push('/armazenamento')} />
        </View>

        <View style={{ backgroundColor: t.surface, borderRadius: 12, padding: spacing.md, gap: spacing.sm }}>
          <Txt style={{ fontWeight: '600' }}>🔑 Segurança da conta</Txt>
          <Txt muted style={{ fontSize: 14 }}>
            Seu PIN impede que alguém use sua conta mesmo clonando o seu chip. O código de recuperação substitui o PIN
            se você esquecê-lo.
          </Txt>
          <Button variant="ghost" title="Trocar PIN" onPress={() => router.push('/pin?modo=trocar')} />
          <Button
            variant="ghost"
            title="Gerar novo código de recuperação"
            onPress={() =>
              Alert.alert('Gerar novo código?', 'O código de recuperação atual deixará de funcionar.', [
                { text: 'Cancelar', style: 'cancel' },
                {
                  text: 'Gerar',
                  onPress: async () => {
                    try {
                      await service.newRecoveryCode();
                      router.push('/recuperacao');
                    } catch (err) {
                      Alert.alert('Não foi possível gerar', errorMessage(err));
                    }
                  },
                },
              ])
            }
          />
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
