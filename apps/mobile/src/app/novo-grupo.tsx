import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView } from 'react-native';

import { errorMessage } from '@/components/format';
import { MemberPicker } from '@/components/member-picker';
import { Button, Field, Txt } from '@/components/ui';
import type { Contact } from '@/core/history';
import { useService } from '@/platform/app';
import { spacing } from '@/theme';

export default function NovoGrupo() {
  const service = useService();
  const router = useRouter();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<Contact[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const id = await service.createGroup(
        name,
        members.map((m) => m.id),
      );
      router.dismissTo({ pathname: '/chat/[id]', params: { id } });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }} keyboardShouldPersistTaps="handled">
      <Field
        label="Nome do grupo"
        placeholder="Família"
        value={name}
        onChangeText={setName}
        maxLength={64}
        error={error}
      />
      <MemberPicker selected={members} onChange={setMembers} />
      <Txt muted style={{ fontSize: 13 }}>
        🔒 As mensagens do grupo são cifradas de ponta a ponta para cada participante. O servidor conhece o nome do
        grupo e quem participa dele, para poder entregar as mensagens.
      </Txt>
      <Button
        title={members.length ? `Criar grupo com ${members.length + 1} pessoas` : 'Criar grupo'}
        onPress={create}
        loading={busy}
        disabled={!name.trim() || members.length === 0}
      />
    </ScrollView>
  );
}
