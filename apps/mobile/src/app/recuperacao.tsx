import * as Clipboard from 'expo-clipboard';
import { Redirect, Stack, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';

import { Button, Screen, Title, Txt } from '@/components/ui';
import { useAppState, useService } from '@/platform/app';
import { spacing, useTheme } from '@/theme';

/** Mostra o código de recuperação uma única vez. */
export default function Recuperacao() {
  const service = useService();
  const router = useRouter();
  const t = useTheme();
  const { recoveryCode } = useAppState();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!recoveryCode) return <Redirect href="/" />;

  const done = async () => {
    setBusy(true);
    await service.recoveryCodeSaved();
    // Não deixa o código na área de transferência.
    if (copied) await Clipboard.setStringAsync('');
    router.replace('/');
  };

  return (
    <Screen>
      <Stack.Screen options={{ title: '', headerBackVisible: false, gestureEnabled: false }} />
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <Title>Guarde seu código de recuperação</Title>
        <Txt muted>
          Se você esquecer o PIN, este código é a única forma de entrar na sua conta num celular novo. Anote em papel ou
          salve num gerenciador de senhas. Ele não será mostrado de novo.
        </Txt>
        <View
          accessible
          accessibilityLabel={`Código de recuperação: ${recoveryCode.split('').join(' ')}`}
          style={{ backgroundColor: t.surface, borderRadius: 12, padding: spacing.lg, alignItems: 'center' }}
        >
          <Txt selectable style={{ fontSize: 20, fontFamily: 'monospace', letterSpacing: 1, textAlign: 'center' }}>
            {recoveryCode.replace(/-/g, ' - ')}
          </Txt>
        </View>
        <Button
          variant="ghost"
          title={copied ? 'Copiado ✓' : 'Copiar para o gerenciador de senhas'}
          onPress={async () => {
            await Clipboard.setStringAsync(recoveryCode);
            setCopied(true);
          }}
        />
        <Txt muted style={{ fontSize: 13 }}>
          Não envie este código para ninguém. A equipe do Bate-Papo nunca vai pedi-lo.
        </Txt>
        <Button title="Já guardei o código" onPress={done} loading={busy} />
      </ScrollView>
    </Screen>
  );
}
