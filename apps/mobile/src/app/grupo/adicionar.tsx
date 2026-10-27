import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { ScrollView } from 'react-native';

import { errorMessage } from '@/components/format';
import { MemberPicker } from '@/components/member-picker';
import { Button, Txt } from '@/components/ui';
import type { Contact } from '@/core/history';
import { useHistoryQuery, useService } from '@/platform/app';
import { spacing, useTheme } from '@/theme';

export default function AdicionarMembros() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const service = useService();
  const t = useTheme();
  const router = useRouter();
  const group = useHistoryQuery((h) => h.getGroup(id), [id]);
  const [selected, setSelected] = useState<Contact[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    try {
      await service.addGroupMembers(
        id,
        selected.map((c) => c.id),
      );
      router.back();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }} keyboardShouldPersistTaps="handled">
      <MemberPicker selected={selected} onChange={setSelected} exclude={group?.members.map((m) => m.userId) ?? []} />
      <Txt muted style={{ fontSize: 13 }}>
        Quem entra não vê as mensagens anteriores. Todos no grupo verão o aviso de entrada.
      </Txt>
      {error ? <Txt style={{ color: t.danger }}>{error}</Txt> : null}
      <Button
        title={selected.length > 1 ? `Adicionar ${selected.length} pessoas` : 'Adicionar'}
        onPress={add}
        loading={busy}
        disabled={selected.length === 0}
      />
    </ScrollView>
  );
}
