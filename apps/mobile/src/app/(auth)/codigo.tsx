import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';

import { errorMessage } from '@/components/format';
import { Button, Field, Screen, Title, Txt } from '@/components/ui';
import { useService } from '@/platform/app';
import { spacing } from '@/theme';

const RESEND_AFTER_S = 60;

export default function Codigo() {
  const service = useService();
  const { phone = '', dev = '' } = useLocalSearchParams<{ phone: string; dev?: string }>();
  // Em desenvolvimento o servidor pode devolver o código, para agilizar testes.
  const [code, setCode] = useState(dev);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [wait, setWait] = useState(RESEND_AFTER_S);

  useEffect(() => {
    if (wait <= 0) return;
    const id = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(id);
  }, [wait]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await service.verifyCode(phone, code);
      // O Gate leva para a próxima tela.
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  const resend = async () => {
    setError(null);
    try {
      const r = await service.requestCode(phone);
      if (__DEV__ && r.dev_code) setCode(r.dev_code);
      setWait(RESEND_AFTER_S);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
          <Title>Confirme seu número</Title>
          <Txt muted>Enviamos um código de 6 dígitos por SMS para {phone}.</Txt>
          <Field
            label="Código"
            placeholder="000000"
            keyboardType="number-pad"
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
            maxLength={6}
            value={code}
            onChangeText={(v) => setCode(v.replace(/\D/g, ''))}
            onSubmitEditing={submit}
            error={error}
            autoFocus
            style={{ letterSpacing: 8, fontSize: 24, textAlign: 'center' }}
          />
          <Button title="Confirmar" onPress={submit} loading={busy} disabled={code.length !== 6} />
          <Button
            variant="ghost"
            title={wait > 0 ? `Reenviar código em ${wait}s` : 'Reenviar código'}
            onPress={resend}
            disabled={wait > 0}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
