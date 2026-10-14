import { Stack } from 'expo-router';

import { useTheme } from '@/theme';

export default function AuthLayout() {
  const t = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: t.background },
        headerTintColor: t.text,
        headerShadowVisible: false,
        headerTitle: '',
        contentStyle: { backgroundColor: t.background },
      }}
    >
      <Stack.Screen name="entrar" options={{ headerShown: false }} />
      <Stack.Screen name="codigo" />
      <Stack.Screen name="desbloquear" />
      <Stack.Screen name="perfil" options={{ headerBackVisible: false, gestureEnabled: false }} />
    </Stack>
  );
}
