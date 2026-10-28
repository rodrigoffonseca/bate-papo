// Notificações push com expo-notifications: token FCM (Android) ou APNs
// (iOS) do próprio aparelho, sem passar pelo serviço de push da Expo.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import type { PushKind } from '@bate-papo/client';

import type { PushPlatform } from '@/core/service';

/** Mesmo nome de canal que o servidor usa nas notificações do FCM. */
const ANDROID_CHANNEL = 'mensagens';

// Com o app aberto, as mensagens chegam pela conexão em tempo real: nada de
// notificação por cima da conversa.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

function toToken(t: Notifications.DevicePushToken): { kind: PushKind; token: string } {
  return { kind: t.type === 'ios' ? 'apns' : 'fcm', token: String(t.data) };
}

export const devicePush: PushPlatform = {
  async getToken() {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL, {
        name: 'Mensagens',
        importance: Notifications.AndroidImportance.HIGH,
        // O aviso é o mesmo para tudo; não mostra conteúdo na tela bloqueada.
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') ({ status } = await Notifications.requestPermissionsAsync());
    if (status !== 'granted') return null;
    // No Android, exige o Firebase configurado no build (google-services.json).
    return toToken(await Notifications.getDevicePushTokenAsync());
  },
  onTokenChange(fn) {
    const sub = Notifications.addPushTokenListener((t) => fn(toToken(t)));
    return () => sub.remove();
  },
};
