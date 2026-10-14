import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native';

import { errorMessage } from '@/components/format';
import { Button, Field, Screen, Title, Txt } from '@/components/ui';
import { usernameProblem } from '@/core/validation';
import { useAppState, useService } from '@/platform/app';
import { spacing } from '@/theme';

export default function Perfil() {
  const service = useService();
  const { me } = useAppState();
  const [displayName, setDisplayName] = useState(me?.display_name ?? '');
  const [username, setUsername] = useState(me?.username ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = username ? usernameProblem(username) : null;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await service.saveProfile({ username: username.trim().replace(/^@/, ''), displayName: displayName.trim() });
    } catch (err) {
      const status = (err as { status?: number }).status;
      setError(status === 409 ? 'Esse nome de usuário já está em uso.' : errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Screen>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
          <Title>Seu perfil</Title>
          <Txt muted>Seus contatos vão encontrar você pelo nome de usuário, sem precisar do seu número.</Txt>
          <Field
            label="Nome"
            placeholder="Como você quer aparecer"
            value={displayName}
            onChangeText={setDisplayName}
            maxLength={64}
            autoComplete="name"
            autoFocus
          />
          <Field
            label="Nome de usuário"
            placeholder="@maria.silva"
            value={username}
            onChangeText={setUsername}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username"
            maxLength={33}
            error={problem ?? error}
          />
          <Button
            title="Continuar"
            onPress={submit}
            loading={busy}
            disabled={!displayName.trim() || !username || !!problem}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
