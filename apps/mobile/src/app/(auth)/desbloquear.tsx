import { UnlockError } from '@bate-papo/client';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';

import { errorMessage } from '@/components/format';
import { Button, Field, Screen, Title, Txt } from '@/components/ui';
import { useService } from '@/platform/app';
import { spacing } from '@/theme';

const MESSAGES: Record<string, string> = {
  pin_blocked: 'Tentativas de PIN esgotadas. Use o código de recuperação.',
  wrong_recovery_code: 'Código de recuperação incorreto.',
  expired: 'O tempo acabou. Peça um novo código SMS.',
  too_many_attempts: 'Muitas tentativas com este código SMS. Peça um novo.',
};

/** A conta tem PIN: o SMS confere, mas é preciso o PIN (ou o código de recuperação). */
export default function Desbloquear() {
  const service = useService();
  const router = useRouter();
  const { token = '', left = '' } = useLocalSearchParams<{ phone: string; token: string; left?: string }>();
  const [useRecovery, setUseRecovery] = useState(left === '0');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(left === '0' ? MESSAGES.pin_blocked! : null);
  const [needsNewSms, setNeedsNewSms] = useState(false);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await service.unlock(token, useRecovery ? { recoveryCode: secret } : { pin: secret });
      // O Gate leva para a próxima tela.
    } catch (err) {
      setBusy(false);
      if (!(err instanceof UnlockError)) return setError(errorMessage(err));
      if (err.reason === 'wrong_pin') {
        return setError(
          err.attemptsLeft
            ? `PIN incorreto. Restam ${err.attemptsLeft} tentativa${err.attemptsLeft > 1 ? 's' : ''}.`
            : MESSAGES.pin_blocked!,
        );
      }
      if (err.reason === 'pin_blocked') setUseRecovery(true);
      if (err.reason === 'expired' || err.reason === 'too_many_attempts') setNeedsNewSms(true);
      setError(MESSAGES[err.reason] ?? errorMessage(err));
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
          <Title>Conta protegida</Title>
          <Txt muted>
            Esta conta tem um PIN. Para usá-la neste aparelho, digite o PIN que você criou.
          </Txt>
          <Txt muted style={{ fontSize: 14 }}>
            Se você não está trocando de celular, alguém pode estar tentando usar o seu número. O aparelho onde a conta
            está foi avisado.
          </Txt>
          {useRecovery ? (
            <Field
              label="Código de recuperação"
              placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
              autoCapitalize="characters"
              autoCorrect={false}
              value={secret}
              onChangeText={setSecret}
              onSubmitEditing={submit}
              error={error}
              autoFocus
            />
          ) : (
            <Field
              label="PIN"
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              value={secret}
              onChangeText={setSecret}
              onSubmitEditing={submit}
              error={error}
              autoFocus
            />
          )}
          {needsNewSms ? (
            <Button title="Pedir novo código SMS" onPress={() => router.dismissTo('/entrar')} />
          ) : (
            <Button title="Entrar" onPress={submit} loading={busy} disabled={secret.length < 6} />
          )}
          <Button
            variant="ghost"
            title={useRecovery ? 'Usar o PIN' : 'Esqueci o PIN: usar código de recuperação'}
            onPress={() => {
              setUseRecovery(!useRecovery);
              setSecret('');
              setError(null);
            }}
          />
          <Txt muted style={{ fontSize: 13 }}>
            Perdeu o PIN e o código de recuperação? Por segurança, a conta só é liberada depois de 7 dias sem uso no
            aparelho antigo. As conversas antigas não são recuperadas: elas só existiam naquele aparelho.
          </Txt>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
