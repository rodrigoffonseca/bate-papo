import type { Sql } from './sql';

/** Armazenamento chave-valor sobre a tabela `kv` (usado pelo SDK). */
export class SqlKV {
  constructor(private readonly db: Sql) {}

  async get(key: string): Promise<string | undefined> {
    const row = await this.db.first<{ value: string }>('SELECT value FROM kv WHERE key = ?', key);
    return row?.value;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.run(
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  async delete(key: string): Promise<void> {
    await this.db.run('DELETE FROM kv WHERE key = ?', key);
  }

  async keys(): Promise<string[]> {
    return (await this.db.all<{ key: string }>('SELECT key FROM kv')).map((r) => r.key);
  }
}
