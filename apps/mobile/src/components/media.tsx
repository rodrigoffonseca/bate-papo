// Conteúdo das bolhas de foto, vídeo e mensagem de voz.

import { toBase64 } from '@bate-papo/crypto';
import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';

import type { Message } from '@/core/history';
import { useService } from '@/platform/app';
import { spacing, useTheme } from '@/theme';

import { errorMessage } from './format';
import { Txt } from './ui';

const BUBBLE_MEDIA_WIDTH = 240;

/** Fotos decifradas em memória (data URI), para não decifrar a cada rolagem. */
const imageCache = new Map<string, string>();
const IMAGE_CACHE_MAX = 30;

/** Esquece as fotos decifradas em memória (ao sair da conta). */
export function clearImageCache(): void {
  imageCache.clear();
}

export function formatDuration(ms: number | undefined): string {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.ceil(bytes / 1024)} KB`;
}

function thumbnailUri(m: Message): string | undefined {
  return m.attachment?.thumbnail ? `data:image/jpeg;base64,${m.attachment.thumbnail}` : undefined;
}

function boxSize(m: Message) {
  const w = m.attachment?.width ?? 4;
  const h = m.attachment?.height ?? 3;
  const ratio = Math.min(Math.max(h / w, 0.5), 1.6);
  return { width: BUBBLE_MEDIA_WIDTH, height: Math.round(BUBBLE_MEDIA_WIDTH * ratio) };
}

/** Foto decifrada (data URI) quando o arquivo estiver no aparelho. */
export function useImageUri(m: Message): string | undefined {
  const service = useService();
  const key = `${m.senderId}:${m.id}`;
  const [uri, setUri] = useState(imageCache.get(key));
  useEffect(() => {
    if (uri || m.mediaState !== 'ready' || !m.attachment) return;
    let alive = true;
    service
      .readMedia(m)
      .then((bytes) => {
        const data = `data:${m.attachment!.mime};base64,${toBase64(bytes)}`;
        if (imageCache.size >= IMAGE_CACHE_MAX) imageCache.delete(imageCache.keys().next().value!);
        imageCache.set(key, data);
        if (alive) setUri(data);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, key, uri, m.mediaState]);
  return uri;
}

/** Faixa de estado sobre a mídia: baixando, expirado, erro ou "toque para baixar". */
function MediaOverlay({ m, onDownload }: { m: Message; onDownload: () => void }) {
  if (m.mediaState === 'downloading') return <ActivityIndicator color="#fff" />;
  const label =
    m.mediaState === 'expired'
      ? 'Arquivo expirado no servidor'
      : m.mediaState === 'error'
        ? 'Falha ao baixar · tocar para tentar'
        : m.mediaState === 'remote'
          ? `⬇ Baixar ${m.attachment ? formatSize(m.attachment.size) : ''}`
          : null;
  if (!label) return null;
  return (
    <Pressable
      accessibilityRole="button"
      disabled={m.mediaState === 'expired'}
      onPress={onDownload}
      style={{ backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6 }}
    >
      <Txt style={{ color: '#fff', fontSize: 13 }}>{label}</Txt>
    </Pressable>
  );
}

export function ImageContent({ m }: { m: Message }) {
  const service = useService();
  const router = useRouter();
  const uri = useImageUri(m);
  const size = boxSize(m);
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={m.text ? `Foto: ${m.text}` : 'Foto'}
      onPress={() =>
        m.mediaState === 'ready'
          ? router.push({ pathname: '/midia', params: { sender: m.senderId, id: m.id } })
          : void service.downloadMedia(m.senderId, m.id)
      }
      style={{ ...size, borderRadius: 12, overflow: 'hidden', backgroundColor: '#0002' }}
    >
      <Image
        source={{ uri: uri ?? thumbnailUri(m) }}
        blurRadius={uri ? 0 : 12}
        contentFit="cover"
        style={{ width: '100%', height: '100%' }}
      />
      <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
        {!uri && <MediaOverlay m={m} onDownload={() => void service.downloadMedia(m.senderId, m.id)} />}
      </View>
    </Pressable>
  );
}

export function VideoContent({ m }: { m: Message }) {
  const service = useService();
  const router = useRouter();
  const size = boxSize(m);
  const ready = m.mediaState === 'ready';
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Vídeo de ${formatDuration(m.attachment?.durationMs)}${ready ? '' : ', toque para baixar'}`}
      onPress={() =>
        ready
          ? router.push({ pathname: '/midia', params: { sender: m.senderId, id: m.id } })
          : void service.downloadMedia(m.senderId, m.id)
      }
      style={{ ...size, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000' }}
    >
      {thumbnailUri(m) && (
        <Image source={{ uri: thumbnailUri(m) }} blurRadius={ready ? 2 : 8} contentFit="cover" style={{ width: '100%', height: '100%' }} />
      )}
      <View style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center', gap: spacing.sm }}>
        {ready ? (
          <Txt style={{ color: '#fff', fontSize: 40 }}>▶</Txt>
        ) : (
          <MediaOverlay m={m} onDownload={() => void service.downloadMedia(m.senderId, m.id)} />
        )}
      </View>
      <Txt style={{ position: 'absolute', left: 8, bottom: 6, color: '#fff', fontSize: 12 }}>
        🎬 {formatDuration(m.attachment?.durationMs)}
      </Txt>
    </Pressable>
  );
}

export function VoiceContent({ m }: { m: Message }) {
  const service = useService();
  const t = useTheme();
  const player = useAudioPlayer(null);
  const status = useAudioPlayerStatus(player);
  const [uri, setUri] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // O arquivo decifrado só existe enquanto a bolha está na tela.
  useEffect(
    () => () => {
      if (uri) void service.releaseMediaFile(uri);
    },
    [service, uri],
  );

  const total = m.attachment?.durationMs ?? (status.duration || 0) * 1000;
  const progress = total > 0 ? Math.min(1, (status.currentTime * 1000) / total) : 0;

  const toggle = async () => {
    setError(null);
    if (status.playing) return player.pause();
    try {
      if (!uri) {
        setLoading(true);
        const u = await service.openMediaFile(m);
        setUri(u);
        player.replace(u);
      } else if (status.didJustFinish || progress >= 1) {
        await player.seekTo(0);
      }
      player.play();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  if (m.mediaState === 'expired') return <Txt muted>🎤 Áudio expirado no servidor</Txt>;
  return (
    <View style={{ width: 220, gap: 4 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={status.playing ? 'Pausar mensagem de voz' : 'Ouvir mensagem de voz'}
          onPress={toggle}
          style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: t.primary, alignItems: 'center', justifyContent: 'center' }}
        >
          {loading || m.mediaState === 'downloading' ? (
            <ActivityIndicator color={t.onPrimary} />
          ) : (
            <Txt style={{ color: t.onPrimary, fontSize: 16 }}>{status.playing ? '❚❚' : '▶'}</Txt>
          )}
        </Pressable>
        <View style={{ flex: 1, height: 4, borderRadius: 2, backgroundColor: t.border }}>
          <View style={{ width: `${progress * 100}%`, height: 4, borderRadius: 2, backgroundColor: t.primary }} />
        </View>
        <Txt muted style={{ fontSize: 12, minWidth: 34 }}>
          {formatDuration(status.playing || progress > 0 ? status.currentTime * 1000 : total)}
        </Txt>
      </View>
      {error && <Txt style={{ color: t.danger, fontSize: 12 }}>{error}</Txt>}
    </View>
  );
}
