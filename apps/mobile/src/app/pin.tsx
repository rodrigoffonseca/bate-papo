import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';

import { errorMessage } from '@/components/format';
import { Button, Field, Screen, Title, Txt } from '@/components/ui';
import { pinProblem } from '@/core/validation';
import { useAppState, useService } from '@/platform/app';
import { spacing } from '@/theme';

/** Cria o PIN (etapa obrigatória do cadastro) ou troca o PIN (ajustes). */
export default function Pin() {
  const service = useService();
  const router = useRouter();
  const { phase } = useAppState();
  const { modo } = useLocalSearchParams<{ modo?: string }>();
  const changing = modo === 'trocar';
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const problem = pin ? pinProblem(pin) : null;
  const mismatch = confirm && confirm !== pin ? 'Os PINs não são iguais.' : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await service.setPin(pin);
      router.replace('/recuperacao');
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: changing ? 'Trocar PIN' : '',
          headerBackVisible: phase === 'ready',
          gestureEnabled: phase === 'ready',
        }}
      />
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
          {!changing && <Title>Proteja sua conta</Title>}
          <Txt muted>
            Crie um PIN. Ele será pedido se alguém tentar usar o seu número em outro celular, por exemplo clonando o
            seu chip. Só o código SMS não basta para entrar na sua conta.
          </Txt>
          <Field
            label="Novo PIN (6 ou mais números ou letras)"
            secureTextEntry
            autoComplete="new-password"
            textContentType="newPassword"
            value={pin}
            onChangeText={setPin}
            error={problem}
            autoFocus
          />
          <Field
            label="Repita o PIN"
            secureTextEntry
            autoComplete="new-password"
            textContentType="newPassword"
            value={confirm}
            onChangeText={setConfirm}
            onSubmitEditing={() => !problem && !mismatch && confirm && submit()}
            error={mismatch ?? error}
          />
          <Button
            title={changing ? 'Trocar PIN' : 'Criar PIN'}
            onPress={submit}
            loading={busy}
            disabled={!pin || !!problem || confirm !== pin}
          />
          <Txt muted style={{ fontSize: 13 }}>
            Use algo que você não esqueça e que não seja sua data de nascimento. Um gerenciador de senhas ajuda.
          </Txt>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
