// Interface mínima de acesso a SQLite. No app é implementada sobre o
// expo-sqlite (com SQLCipher); nos testes, sobre o node:sqlite.

export type SqlParam = string | number | null;

export interface Sql {
  exec(sql: string): Promise<void>;
  run(sql: string, ...params: SqlParam[]): Promise<void>;
  all<T>(sql: string, ...params: SqlParam[]): Promise<T[]>;
  first<T>(sql: string, ...params: SqlParam[]): Promise<T | null>;
}

const MIGRATIONS = [
  `
  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE contacts (
    id           TEXT PRIMARY KEY,
    username     TEXT,
    display_name TEXT,
    updated_at   INTEGER NOT NULL
  );

  CREATE TABLE conversations (
    id        TEXT PRIMARY KEY,
    kind      TEXT NOT NULL CHECK (kind IN ('direct', 'group')),
    peer_id   TEXT NOT NULL,
    last_text TEXT,
    last_at   INTEGER NOT NULL,
    unread    INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE messages (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender_id       TEXT NOT NULL,
    id              TEXT NOT NULL,
    kind            TEXT NOT NULL,
    text            TEXT,
    sent_at         INTEGER NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'failed', 'received')),
    PRIMARY KEY (sender_id, id)
  );
  CREATE INDEX messages_conversation_idx ON messages (conversation_id, sent_at);
  `,
  // Fotos, vídeos e áudios: o ponteiro do anexo (com a chave) fica aqui, no
  // banco cifrado; o arquivo fica no aparelho, ainda cifrado.
  `
  ALTER TABLE messages ADD COLUMN attachment TEXT;
  ALTER TABLE messages ADD COLUMN media_state TEXT;
  `,
  // Grupos: cópia local do estado no servidor, para mostrar nomes e membros
  // sem rede e perceber (e mostrar na conversa) quem entrou e quem saiu.
  `
  CREATE TABLE groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    active     INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE group_members (
    group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL,
    role     TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    PRIMARY KEY (group_id, user_id)
  );
  `,
];

/** Aplica as migrações pendentes, controladas por PRAGMA user_version. */
export async function migrate(db: Sql): Promise<void> {
  await db.exec('PRAGMA foreign_keys = ON');
  const row = await db.first<{ user_version: number }>('PRAGMA user_version');
  for (let v = row?.user_version ?? 0; v < MIGRATIONS.length; v++) {
    await db.exec(`BEGIN; ${MIGRATIONS[v]}; PRAGMA user_version = ${v + 1}; COMMIT;`);
  }
}
