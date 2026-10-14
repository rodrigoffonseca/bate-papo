import { useColorScheme } from 'react-native';

const light = {
  background: '#FFFFFF',
  surface: '#F2F4F3',
  text: '#101413',
  textMuted: '#5E6764',
  border: '#E1E5E3',
  primary: '#128C4A',
  onPrimary: '#FFFFFF',
  bubbleOut: '#D9F4E3',
  bubbleIn: '#F2F4F3',
  danger: '#C62828',
  warningBg: '#FFF4D6',
  warningText: '#6B4E00',
};

const dark: typeof light = {
  background: '#0E1110',
  surface: '#1A1F1D',
  text: '#EEF2F0',
  textMuted: '#9AA5A1',
  border: '#2A312E',
  primary: '#2FBF71',
  onPrimary: '#04140B',
  bubbleOut: '#164A2D',
  bubbleIn: '#1F2522',
  danger: '#EF6B6B',
  warningBg: '#3A2F0F',
  warningText: '#F5D27A',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}

export const spacing = { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 } as const;
