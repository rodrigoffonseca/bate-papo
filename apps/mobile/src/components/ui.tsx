import type { ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  type TextProps,
  View,
  type ViewProps,
} from 'react-native';

import { spacing, useTheme } from '@/theme';

export function Screen({ style, ...rest }: ViewProps) {
  const t = useTheme();
  return <View style={[{ flex: 1, backgroundColor: t.background }, style]} {...rest} />;
}

export function Txt({ muted, style, ...rest }: TextProps & { muted?: boolean }) {
  const t = useTheme();
  return <Text style={[{ color: muted ? t.textMuted : t.text, fontSize: 16 }, style]} {...rest} />;
}

export function Title({ style, ...rest }: TextProps) {
  const t = useTheme();
  return <Text accessibilityRole="header" style={[{ color: t.text, fontSize: 28, fontWeight: '700' }, style]} {...rest} />;
}

export function Field({ label, error, style, ...rest }: TextInputProps & { label: string; error?: string | null }) {
  const t = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      <Txt muted style={{ fontSize: 14 }}>
        {label}
      </Txt>
      <TextInput
        accessibilityLabel={label}
        placeholderTextColor={t.textMuted}
        style={[
          styles.input,
          { color: t.text, backgroundColor: t.surface, borderColor: error ? t.danger : t.border },
          style,
        ]}
        {...rest}
      />
      {error ? <Txt style={{ color: t.danger, fontSize: 14 }}>{error}</Txt> : null}
    </View>
  );
}

export function Button({
  title,
  onPress,
  loading,
  disabled,
  variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
}) {
  const t = useTheme();
  const inactive = disabled || loading;
  const bg = variant === 'primary' ? t.primary : 'transparent';
  const fg = variant === 'primary' ? t.onPrimary : variant === 'danger' ? t.danger : t.primary;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!inactive, busy: !!loading }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [styles.button, { backgroundColor: bg, opacity: inactive ? 0.5 : pressed ? 0.8 : 1 }]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontSize: 16, fontWeight: '600' }}>{title}</Text>}
    </Pressable>
  );
}

const AVATAR_COLORS = ['#128C4A', '#1565C0', '#AD1457', '#6A1B9A', '#EF6C00', '#00838F', '#5D4037'];

export function Avatar({ name, seed, size = 44 }: { name: string; seed: string; size?: number }) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const initials =
    name
      .replace(/^@/, '')
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('') || '?';
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: AVATAR_COLORS[h % AVATAR_COLORS.length],
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#fff', fontWeight: '700', fontSize: size * 0.38 }}>{initials}</Text>
    </View>
  );
}

export function Banner({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <View accessibilityLiveRegion="polite" style={{ backgroundColor: t.warningBg, padding: spacing.sm, paddingHorizontal: spacing.md }}>
      <Text style={{ color: t.warningText, fontSize: 14 }}>{children}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  input: { borderWidth: 1, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 12, fontSize: 17 },
  button: { borderRadius: 12, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', minHeight: 50 },
});
