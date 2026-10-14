// Banco local cifrado com SQLCipher. A chave (256 bits, aleatória) fica no
// Keychain (iOS) / Keystore (Android) e não sai do aparelho nem vai para
// backups.

import { toHex } from '@bate-papo/crypto';
import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';

import type { Sql } from '@/core/sql';

const DB_NAME = 'batepapo.db';
const KEY_NAME = 'batepapo.db-key';
const KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
};

async function databaseKey(): Promise<{ key: string; isNew: boolean }> {
  const existing = await SecureStore.getItemAsync(KEY_NAME, KEY_OPTIONS);
  if (existing) return { key: existing, isNew: false };
  const key = toHex(crypto.getRandomValues(new Uint8Array(32)));
  await SecureStore.setItemAsync(KEY_NAME, key, KEY_OPTIONS);
  return { key, isNew: true };
}

async function openWithKey(key: string): Promise<SQLite.SQLiteDatabase> {
  const db = await SQLite.openDatabaseAsync(DB_NAME);
  await db.execAsync(`PRAGMA key = "x'${key}'"`);
  // Falha aqui se a chave não abrir o arquivo.
  await db.getFirstAsync('SELECT count(*) FROM sqlite_master');
  return db;
}

export async function openEncryptedDatabase(): Promise<Sql> {
  const { key, isNew } = await databaseKey();
  let db: SQLite.SQLiteDatabase;
  try {
    db = await openWithKey(key);
  } catch (err) {
    if (!isNew) throw err;
    // Chave nova mas arquivo antigo (ex.: Keystore apagado): os dados antigos
    // são ilegíveis de qualquer forma; começa do zero.
    await SQLite.deleteDatabaseAsync(DB_NAME);
    db = await openWithKey(key);
  }
  return {
    exec: (sql) => db.execAsync(sql),
    run: async (sql, ...params) => {
      await db.runAsync(sql, params);
    },
    all: (sql, ...params) => db.getAllAsync(sql, params),
    first: (sql, ...params) => db.getFirstAsync(sql, params),
  };
}
