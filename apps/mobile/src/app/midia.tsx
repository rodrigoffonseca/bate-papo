import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';

import { errorMessage } from '@/components/format';
import { useImageUri } from '@/components/media';
import { Txt } from '@/components/ui';
import type { Message } from '@/core/history';
import { useHistoryQuery, useService } from '@/platform/app';
import { spacing } from '@/theme';

function VideoPlayer({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri, (p) => p.play());
  return <VideoView player={player} nativeControls contentFit="contain" style={{ flex: 1 }} />;
}

function VideoScreen({ m }: { m: Message }) {
  const service = useService();
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let opened: string | null = null;
    service
      .openMediaFile(m)
      .then((u) => {
        opened = u;
        if (alive) setUri(u);
        else void service.releaseMediaFile(u);
      })
      .catch((err) => alive && setError(errorMessage(err)));
    // O arquivo decifrado é apagado ao sair da tela.
    return () => {
      alive = false;
      if (opened) void service.releaseMediaFile(opened);
    };
    // Reabre só se mudar a mensagem (o objeto é recriado a cada consulta).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service, m.senderId, m.id]);

  if (error) return <Txt style={{ color: '#fff', padding: spacing.lg }}>{error}</Txt>;
  if (!uri) return <ActivityIndicator color="#fff" style={{ flex: 1 }} />;
  return <VideoPlayer uri={uri} />;
}

function ImageScreen({ m }: { m: Message }) {
  const uri = useImageUri(m);
  if (!uri) return <ActivityIndicator color="#fff" style={{ flex: 1 }} />;
  return <Image source={{ uri }} contentFit="contain" style={{ flex: 1 }} accessibilityLabel={m.text ?? 'Foto'} />;
}

/** Foto ou vídeo em tela cheia. */
export default function Midia() {
  const { sender = '', id = '' } = useLocalSearchParams<{ sender: string; id: string }>();
  const m = useHistoryQuery((h) => h.getMessage(sender, id), [sender, id]);

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Stack.Screen
        options={{
          title: '',
          headerStyle: { backgroundColor: '#000' },
          headerTintColor: '#fff',
          contentStyle: { backgroundColor: '#000' },
        }}
      />
      {!m ? null : m.kind === 'video' ? <VideoScreen m={m} /> : <ImageScreen m={m} />}
      {m?.text ? (
        <Txt style={{ color: '#fff', padding: spacing.md, textAlign: 'center' }}>{m.text}</Txt>
      ) : null}
    </View>
  );
}
