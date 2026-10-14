import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView } from 'react-native';

import { errorMessage } from '@/components/format';
import { Button, Field, Screen, Txt } from '@/components/ui';
import { useService } from '@/platform/app';
import { spacing } from '@/theme';

/** Lembrete periódico: confirmar o PIN para não esquecê-lo. */
export default function LembretePin() {
  const service = useService();
  const router = useRouter();
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      if (await service.confirmPin(pin)) return router.back();
      setError('PIN incorreto. Se esqueceu, crie um novo em Ajustes.');
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
  };

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <Txt muted>
          Confirme seu PIN de vez em quando para não esquecê-lo. Ele protege sua conta se alguém clonar o seu chip.
        </Txt>
        <Field
          label="PIN"
          secureTextEntry
          autoComplete="current-password"
          value={pin}
          onChangeText={setPin}
          onSubmitEditing={submit}
          error={error}
          autoFocus
        />
        <Button title="Confirmar" onPress={submit} loading={busy} disabled={pin.length < 6} />
        <Button variant="ghost" title="Esqueci: criar um novo PIN" onPress={() => router.replace('/pin?modo=trocar')} />
      </ScrollView>
    </Screen>
  );
}
