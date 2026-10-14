import { Platform } from 'react-native';

/**
 * Endereço do servidor. Defina EXPO_PUBLIC_SERVER_URL (ex.: no arquivo
 * .env.local). Sem ele, usa o servidor local de desenvolvimento: no emulador
 * Android, 10.0.2.2 é o computador hospedeiro.
 */
export const SERVER_URL =
  process.env.EXPO_PUBLIC_SERVER_URL ??
  (Platform.OS === 'android' ? 'http://10.0.2.2:8080' : 'http://localhost:8080');
