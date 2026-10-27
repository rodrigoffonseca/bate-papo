import { Image } from 'expo-image';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, View } from 'react-native';

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
  const service = useService();
  const router = useRouter();

  const clear = () =>
    Alert.alert(
      'Apagar do aparelho?',
      'A mensagem continua na conversa. Dá para baixar de novo enquanto o servidor ainda tiver o arquivo (até 30 dias depois do envio).',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Apagar',
          style: 'destructive',
          onPress: async () => {
            if (!m) return;
            const ok = await service.clearMediaItem(m);
            if (!ok) Alert.alert('Ainda não enviada', 'Esta mídia ainda não foi enviada; apagar agora perderia a única cópia.');
            else router.back();
          },
        },
      ],
    );

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <Stack.Screen
        options={{
          title: '',
          headerStyle: { backgroundColor: '#000' },
          headerTintColor: '#fff',
          contentStyle: { backgroundColor: '#000' },
          headerRight: () => (
            <Pressable accessibilityRole="button" accessibilityLabel="Apagar do aparelho" onPress={clear} hitSlop={12}>
              <Txt style={{ color: '#fff', fontSize: 15 }}>Apagar do aparelho</Txt>
            </Pressable>
          ),
        }}
      />
      {!m ? null : m.kind === 'video' ? <VideoScreen m={m} /> : <ImageScreen m={m} />}
      {m?.text ? (
        <Txt style={{ color: '#fff', padding: spacing.md, textAlign: 'center' }}>{m.text}</Txt>
      ) : null}
    </View>
  );
}
