import { Stack, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';

import { AppProvider, useAppState } from '@/platform/app';
import { useTheme } from '@/theme';

SplashScreen.preventAutoHideAsync();

/** Leva cada pessoa à tela certa conforme a etapa do cadastro. */
function Gate() {
  const { phase } = useAppState();
  const segments = useSegments();
  const router = useRouter();
  const t = useTheme();

  useEffect(() => {
    if (phase === 'loading') return;
    SplashScreen.hideAsync();
    const [group, screen] = segments as string[];
    const inAuth = group === '(auth)';
    if (phase === 'signed-out' && (!inAuth || screen === 'perfil')) router.replace('/entrar');
    else if (phase === 'needs-profile' && screen !== 'perfil') router.replace('/perfil');
    else if (phase === 'ready' && inAuth) router.replace('/');
  }, [phase, segments, router]);

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.background },
        headerTintColor: t.text,
        headerShadowVisible: false,
        contentStyle: { backgroundColor: t.background },
      }}
    >
      <Stack.Screen name="(auth)" options={{ headerShown: false }} />
      <Stack.Screen name="index" options={{ title: 'Bate-Papo' }} />
      <Stack.Screen name="nova" options={{ title: 'Nova conversa', presentation: 'modal' }} />
      <Stack.Screen name="chat/[id]" options={{ title: '' }} />
      <Stack.Screen name="ajustes" options={{ title: 'Ajustes' }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <AppProvider fallback={null}>
      <StatusBar style="auto" />
      <Gate />
    </AppProvider>
  );
}
