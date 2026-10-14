import { useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { errorMessage } from '@/components/format';
import { Button, Field, Screen, Title, Txt } from '@/components/ui';
import { useService } from '@/platform/app';
import { spacing } from '@/theme';

export default function Entrar() {
  const service = useService();
  const router = useRouter();
  const [phone, setPhone] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await service.requestCode(phone);
      router.push({ pathname: '/codigo', params: { phone, dev: __DEV__ ? (r.dev_code ?? '') : '' } });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <SafeAreaView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
          <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg, flexGrow: 1, justifyContent: 'center' }}>
            <Title>Bate-Papo</Title>
            <Txt muted>
              Mensagens protegidas com criptografia de ponta a ponta. Só você e quem conversa com você conseguem ler.
            </Txt>
            <Field
              label="Seu número de celular, com DDD"
              placeholder="(11) 98765-4321"
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              value={phone}
              onChangeText={setPhone}
              onSubmitEditing={submit}
              error={error}
              autoFocus
            />
            <Button title="Receber código por SMS" onPress={submit} loading={busy} disabled={phone.replace(/\D/g, '').length < 10} />
            <Txt muted style={{ fontSize: 13 }}>
              Seu número é usado só para confirmar a conta e não fica guardado em texto no servidor.
            </Txt>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Screen>
  );
}
