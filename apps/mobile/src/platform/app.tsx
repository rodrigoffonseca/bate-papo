import { fetch as expoFetch, type FetchRequestInit } from 'expo/fetch';
import { createContext, type ReactNode, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState as RNAppState } from 'react-native';

import type { FetchLike } from '@bate-papo/client';

import type { History } from '@/core/history';
import { type AppState, AppService } from '@/core/service';

import { SERVER_URL } from './config';
import { openEncryptedDatabase } from './db';
import { deviceMediaStore } from './media';

const ServiceContext = createContext<AppService | null>(null);

// O fetch do Expo aceita Uint8Array como corpo; a diferença é só de tipagem
// (Uint8Array<ArrayBufferLike> x BodyInit).
const expoFetchLike: FetchLike = (url, init) =>
  expoFetch(url, init && { ...init, body: init.body as FetchRequestInit['body'] });

let servicePromise: Promise<AppService> | null = null;

function startService(): Promise<AppService> {
  servicePromise ??= (async () => {
    const service = new AppService({
      db: await openEncryptedDatabase(),
      media: deviceMediaStore,
      serverUrl: SERVER_URL,
      fetch: expoFetchLike,
    });
    await service.init();
    return service;
  })();
  return servicePromise;
}

/** Abre o banco, restaura a sessão e mantém a conexão conforme o app vai e volta. */
export function AppProvider({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const [service, setService] = useState<AppService | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    startService().then(setService, setError);
  }, []);

  useEffect(() => {
    if (!service) return;
    const sub = RNAppState.addEventListener('change', (s) => (s === 'active' ? service.resume() : service.pause()));
    return () => sub.remove();
  }, [service]);

  if (error) throw error;
  if (!service) return fallback;
  return <ServiceContext.Provider value={service}>{children}</ServiceContext.Provider>;
}

export function useService(): AppService {
  const s = useContext(ServiceContext);
  if (!s) throw new Error('useService fora do AppProvider');
  return s;
}

export function useAppState(): AppState {
  const s = useService();
  return useSyncExternalStore(s.subscribe, s.getState);
}

/** Executa uma consulta ao histórico e a refaz sempre que ele muda. */
export function useHistoryQuery<T>(query: (h: History) => Promise<T>, deps: unknown[]): T | undefined {
  const { history } = useService();
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let alive = true;
    const run = () => {
      query(history).then((v) => alive && setValue(v), () => undefined);
    };
    run();
    const off = history.onChange(run);
    return () => {
      alive = false;
      off();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, ...deps]);
  return value;
}
