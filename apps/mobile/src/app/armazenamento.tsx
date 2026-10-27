import { useCallback, useEffect, useState } from 'react';
import { Alert, Pressable, ScrollView, View } from 'react-native';

import { errorMessage } from '@/components/format';
import { clearImageCache, formatSize } from '@/components/media';
import { Button, Screen, Txt } from '@/components/ui';
import type { MediaFilter, MediaKindName, MediaUsage } from '@/core/history';
import { AUTO_CLEANUP_OPTIONS, type CleanupResult } from '@/core/service';
import { useAppState, useService } from '@/platform/app';
import { spacing, useTheme } from '@/theme';

const KIND_LABEL: Record<MediaKindName, string> = { image: 'Fotos', video: 'Vídeos', voice: 'Áudios' };
const KIND_ICON: Record<MediaKindName, string> = { image: '📷', video: '🎬', voice: '🎤' };
const DAY_MS = 24 * 60 * 60 * 1000;

function cleanupLabel(days: number): string {
  return days === 0 ? 'Desligada' : days === 365 ? 'Mais de 1 ano' : `Mais de ${days} dias`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.surface, borderRadius: 12, padding: spacing.md, gap: spacing.sm }}>
      <Txt style={{ fontWeight: '600' }}>{title}</Txt>
      {children}
    </View>
  );
}

/** Espaço usado por fotos, vídeos e áudios, e limpeza. */
export default function Armazenamento() {
  const service = useService();
  const { autoCleanupDays } = useAppState();
  const t = useTheme();
  const [usage, setUsage] = useState<MediaUsage | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    service.mediaUsage().then(setUsage, () => undefined);
  }, [service]);
  useEffect(() => {
    refresh();
    return service.history.onChange(refresh);
  }, [service, refresh]);

  const report = (r: CleanupResult | null) => {
    clearImageCache();
    if (!r) return;
    const freed = r.count ? `${r.count} arquivo${r.count > 1 ? 's' : ''} apagado${r.count > 1 ? 's' : ''} (${formatSize(r.bytes)}).` : 'Nada para apagar.';
    const kept = r.skipped ? ` ${r.skipped} ainda não enviado${r.skipped > 1 ? 's' : ''} foi mantido.` : '';
    Alert.alert('Limpeza concluída', freed + kept);
  };

  const confirmClear = (what: string, filter: MediaFilter) =>
    Alert.alert(
      `Apagar ${what}?`,
      'As mensagens continuam nas conversas. Dá para baixar de novo enquanto o servidor ainda tiver o arquivo (até 30 dias depois do envio).',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Apagar',
          style: 'destructive',
          onPress: async () => {
            setBusy(true);
            try {
              report(await service.clearMedia(filter));
            } catch (err) {
              Alert.alert('Não foi possível apagar', errorMessage(err));
            } finally {
              setBusy(false);
            }
          },
        },
      ],
    );

  const conversationOptions = (conversationId: string, title: string) =>
    Alert.alert(title, 'O que apagar do aparelho?', [
      { text: 'Fotos', onPress: () => confirmClear(`as fotos de ${title}`, { conversationId, kinds: ['image'] }) },
      { text: 'Vídeos', onPress: () => confirmClear(`os vídeos de ${title}`, { conversationId, kinds: ['video'] }) },
      { text: 'Áudios', onPress: () => confirmClear(`os áudios de ${title}`, { conversationId, kinds: ['voice'] }) },
      { text: 'Toda a mídia', style: 'destructive', onPress: () => confirmClear(`toda a mídia de ${title}`, { conversationId }) },
      { text: 'Cancelar', style: 'cancel' },
    ]);

  const max = usage ? Math.max(1, ...Object.values(usage.byKind).map((k) => k.bytes)) : 1;

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: spacing.lg, gap: spacing.lg }}>
        <View style={{ alignItems: 'center', gap: spacing.xs }}>
          <Txt style={{ fontSize: 32, fontWeight: '700' }}>{usage ? formatSize(usage.totalBytes) : '…'}</Txt>
          <Txt muted>de fotos, vídeos e áudios neste aparelho</Txt>
        </View>

        <Section title="Por tipo">
          {(Object.keys(KIND_LABEL) as MediaKindName[]).map((k) => (
            <Pressable
              key={k}
              accessibilityRole="button"
              accessibilityLabel={`${KIND_LABEL[k]}: ${formatSize(usage?.byKind[k].bytes ?? 0)}. Toque para apagar`}
              disabled={!usage?.byKind[k].count || busy}
              onPress={() => confirmClear(`todos os ${KIND_LABEL[k].toLowerCase()}`, { kinds: [k] })}
              style={{ gap: 4, paddingVertical: 4 }}
            >
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <Txt>
                  {KIND_ICON[k]} {KIND_LABEL[k]} · {usage?.byKind[k].count ?? 0}
                </Txt>
                <Txt muted>{formatSize(usage?.byKind[k].bytes ?? 0)}</Txt>
              </View>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: t.border }}>
                <View
                  style={{
                    height: 6,
                    borderRadius: 3,
                    backgroundColor: t.primary,
                    width: `${((usage?.byKind[k].bytes ?? 0) / max) * 100}%`,
                  }}
                />
              </View>
            </Pressable>
          ))}
        </Section>

        <Section title="Por conversa">
          {usage?.byConversation.length ? (
            usage.byConversation.map((c) => (
              <Pressable
                key={c.conversationId}
                accessibilityRole="button"
                accessibilityLabel={`${c.title}: ${formatSize(c.bytes)}. Toque para escolher o que apagar`}
                disabled={busy}
                onPress={() => conversationOptions(c.conversationId, c.title)}
                style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6 }}
              >
                <Txt numberOfLines={1} style={{ flex: 1 }}>
                  {c.title} · {c.count}
                </Txt>
                <Txt muted>{formatSize(c.bytes)} ›</Txt>
              </Pressable>
            ))
          ) : (
            <Txt muted>Nenhuma mídia guardada.</Txt>
          )}
        </Section>

        <Section title="Apagar mídia antiga">
          <Button
            variant="ghost"
            title="Com mais de 30 dias"
            disabled={busy || !usage?.totalBytes}
            onPress={() => confirmClear('a mídia com mais de 30 dias', { olderThan: Date.now() - 30 * DAY_MS })}
          />
          <Button
            variant="ghost"
            title="Com mais de 90 dias"
            disabled={busy || !usage?.totalBytes}
            onPress={() => confirmClear('a mídia com mais de 90 dias', { olderThan: Date.now() - 90 * DAY_MS })}
          />
          <Button
            variant="danger"
            title="Apagar toda a mídia"
            disabled={busy || !usage?.totalBytes}
            onPress={() => confirmClear('toda a mídia do aparelho', {})}
          />
        </Section>

        <Section title="Limpeza automática">
          <Txt muted style={{ fontSize: 14 }}>
            Apaga do aparelho, sempre que o app abrir, a mídia mais antiga que o prazo escolhido.
          </Txt>
          {AUTO_CLEANUP_OPTIONS.map((days) => (
            <Pressable
              key={days}
              accessibilityRole="radio"
              accessibilityState={{ checked: autoCleanupDays === days }}
              onPress={async () => report(await service.setAutoCleanup(days))}
              style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: 6 }}
            >
              <View
                style={{
                  width: 20,
                  height: 20,
                  borderRadius: 10,
                  borderWidth: 2,
                  borderColor: t.primary,
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {autoCleanupDays === days && <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.primary }} />}
              </View>
              <Txt>{cleanupLabel(days)}</Txt>
            </Pressable>
          ))}
        </Section>

        <Txt muted style={{ fontSize: 13 }}>
          Fotos, vídeos e áudios ficam guardados cifrados neste aparelho. Mídia que ainda não foi enviada nunca é apagada
          pela limpeza.
        </Txt>
      </ScrollView>
    </Screen>
  );
}
