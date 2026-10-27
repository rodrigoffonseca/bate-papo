import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { errorMessage } from '@/components/format';
import { Button, Field, Screen, Txt } from '@/components/ui';
import { useService } from '@/platform/app';
import { spacing } from '@/theme';

export default function Nova() {
  const service = useService();
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await service.startConversation(username);
      router.dismissTo({ pathname: '/chat/[id]', params: { id } });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <View style={{ padding: spacing.lg, gap: spacing.lg }}>
        <Button variant="ghost" title="👥 Novo grupo" onPress={() => router.replace('/novo-grupo')} />
        <Txt muted>Digite o nome de usuário da pessoa com quem você quer conversar.</Txt>
        <Field
          label="Nome de usuário"
          placeholder="@maria"
          value={username}
          onChangeText={setUsername}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={submit}
          error={error}
          autoFocus
        />
        <Button title="Conversar" onPress={submit} loading={busy} disabled={username.replace('@', '').trim().length < 3} />
      </View>
    </Screen>
  );
}
