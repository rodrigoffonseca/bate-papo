import { useState } from 'react';
import { Pressable, View } from 'react-native';

import { errorMessage } from '@/components/format';
import { Avatar, Button, Field, Txt } from '@/components/ui';
import { type Contact, contactTitle } from '@/core/history';
import { useHistoryQuery, useService } from '@/platform/app';
import { spacing, useTheme } from '@/theme';

/**
 * Escolha de pessoas para um grupo: contatos conhecidos ou busca por @nome.
 * `exclude` esconde quem já está no grupo.
 */
export function MemberPicker({
  selected,
  onChange,
  exclude = [],
}: {
  selected: Contact[];
  onChange: (next: Contact[]) => void;
  exclude?: string[];
}) {
  const t = useTheme();
  const service = useService();
  const contacts = useHistoryQuery((h) => h.listContacts(), []);
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isSelected = (id: string) => selected.some((c) => c.id === id);
  const toggle = (c: Contact) => onChange(isSelected(c.id) ? selected.filter((x) => x.id !== c.id) : [...selected, c]);

  const search = async () => {
    setBusy(true);
    setError(null);
    try {
      const c = await service.findUser(username);
      if (exclude.includes(c.id)) setError(`${contactTitle(c)} já está no grupo`);
      else {
        if (!isSelected(c.id)) onChange([...selected, c]);
        setUsername('');
      }
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  // Quem foi achado pela busca aparece na lista mesmo antes de ela recarregar.
  const known = [...(contacts ?? [])];
  for (const c of selected) if (!known.some((k) => k.id === c.id)) known.push(c);
  const options = known.filter((c) => !exclude.includes(c.id));

  return (
    <View style={{ gap: spacing.md }}>
      <Field
        label="Adicionar pelo nome de usuário"
        placeholder="@maria"
        value={username}
        onChangeText={setUsername}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={search}
        error={error}
      />
      <Button
        variant="ghost"
        title="Buscar e adicionar"
        onPress={search}
        loading={busy}
        disabled={username.replace('@', '').trim().length < 3}
      />
      {options.length > 0 && (
        <Txt muted style={{ fontSize: 14 }}>
          Contatos
        </Txt>
      )}
      {options.map((c) => {
        const on = isSelected(c.id);
        return (
          <Pressable
            key={c.id}
            onPress={() => toggle(c)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: on }}
            accessibilityLabel={contactTitle(c)}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              paddingVertical: spacing.sm,
              opacity: pressed ? 0.7 : 1,
            })}
          >
            <Avatar name={contactTitle(c)} seed={c.id} size={36} />
            <View style={{ flex: 1 }}>
              <Txt numberOfLines={1}>{contactTitle(c)}</Txt>
              {c.username && c.displayName ? (
                <Txt muted style={{ fontSize: 13 }}>
                  @{c.username}
                </Txt>
              ) : null}
            </View>
            <View
              style={{
                width: 24,
                height: 24,
                borderRadius: 12,
                borderWidth: 2,
                borderColor: on ? t.primary : t.border,
                backgroundColor: on ? t.primary : 'transparent',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              {on && (
                <Txt
                  style={{
                    color: t.onPrimary,
                    fontSize: 14,
                    fontWeight: '700',
                  }}
                >
                  ✓
                </Txt>
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}
