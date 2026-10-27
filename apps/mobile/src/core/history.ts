// Histórico de conversas. Existe apenas no aparelho: o servidor apaga cada
// mensagem assim que ela é entregue.

import type { Sql } from './sql';

export type MessageStatus = 'sending' | 'sent' | 'failed' | 'received';

/**
 * Estado do arquivo de um anexo neste aparelho:
 * - ready: guardado (cifrado) no aparelho;
 * - remote: só no servidor (ainda não baixado);
 * - downloading: baixando;
 * - expired: o servidor já apagou e ele nunca foi baixado;
 * - error: falhou ao baixar (dá para tentar de novo).
 */
export type MediaState = 'ready' | 'remote' | 'downloading' | 'expired' | 'error';

/** Ponteiro do anexo guardado com a mensagem. id vazio = ainda não enviado ao servidor. */
export interface StoredAttachment {
  id: string;
  key: string;
  digest: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  durationMs?: number;
  thumbnail?: string;
}

export interface Contact {
  id: string;
  username: string | null;
  displayName: string | null;
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'group';
  peerId: string;
  title: string;
  lastText: string | null;
  lastAt: number;
  unread: number;
}

export interface Message {
  conversationId: string;
  senderId: string;
  id: string;
  kind: string;
  text: string | null;
  sentAt: number;
  status: MessageStatus;
  outgoing: boolean;
  attachment?: StoredAttachment;
  mediaState?: MediaState;
}

export function directConversationId(userId: string): string {
  return `u:${userId}`;
}

export function contactTitle(c: Pick<Contact, 'username' | 'displayName'> | null | undefined): string {
  if (c?.displayName) return c.displayName;
  if (c?.username) return `@${c.username}`;
  return 'Contato';
}

function preview(kind: string, text: string | null): string {
  if (kind === 'image') return text ? `📷 ${text}` : '📷 Foto';
  if (kind === 'video') return text ? `🎬 ${text}` : '🎬 Vídeo';
  if (kind === 'voice') return '🎤 Mensagem de voz';
  return text ?? '';
}

interface MessageRow {
  conversation_id: string;
  sender_id: string;
  id: string;
  kind: string;
  text: string | null;
  sent_at: number;
  status: MessageStatus;
  attachment: string | null;
  media_state: MediaState | null;
}

const MESSAGE_COLS = 'conversation_id, sender_id, id, kind, text, sent_at, status, attachment, media_state';

export class History {
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly db: Sql,
    private readonly myId: () => string,
  ) {}

  /** Avisa quando algo muda (para atualizar as telas). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }

  async upsertContact(c: Contact): Promise<void> {
    await this.db.run(
      `INSERT INTO contacts (id, username, display_name, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET username = excluded.username,
         display_name = excluded.display_name, updated_at = excluded.updated_at`,
      c.id,
      c.username,
      c.displayName,
      Date.now(),
    );
    this.changed();
  }

  async getContact(id: string): Promise<Contact | null> {
    const r = await this.db.first<{ id: string; username: string | null; display_name: string | null }>(
      'SELECT id, username, display_name FROM contacts WHERE id = ?',
      id,
    );
    return r && { id: r.id, username: r.username, displayName: r.display_name };
  }

  private async touchConversation(peerId: string, kind: string, text: string | null, at: number, unread: number) {
    const id = directConversationId(peerId);
    await this.db.run(
      `INSERT INTO conversations (id, kind, peer_id, last_text, last_at, unread) VALUES (?, 'direct', ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         last_text = CASE WHEN excluded.last_at >= conversations.last_at THEN excluded.last_text ELSE conversations.last_text END,
         last_at   = MAX(conversations.last_at, excluded.last_at),
         unread    = conversations.unread + excluded.unread`,
      id,
      peerId,
      preview(kind, text),
      at,
      unread,
    );
    return id;
  }

  /** Garante que a conversa exista (ex.: ao iniciar uma nova). */
  async ensureDirectConversation(peerId: string): Promise<string> {
    const id = directConversationId(peerId);
    await this.db.run(
      `INSERT INTO conversations (id, kind, peer_id, last_text, last_at, unread)
       VALUES (?, 'direct', ?, NULL, ?, 0) ON CONFLICT (id) DO NOTHING`,
      id,
      peerId,
      Date.now(),
    );
    this.changed();
    return id;
  }

  /** Guarda uma mensagem recebida. Repetições (mesmo remetente e ID) são ignoradas. */
  async saveIncoming(
    m: { from: string; id: string; kind: string; text?: string; sentAt: number; attachment?: StoredAttachment },
    opts: { read: boolean },
  ): Promise<boolean> {
    const exists = await this.db.first('SELECT 1 FROM messages WHERE sender_id = ? AND id = ?', m.from, m.id);
    if (exists) return false;
    const conversationId = await this.touchConversation(m.from, m.kind, m.text ?? null, m.sentAt, opts.read ? 0 : 1);
    await this.db.run(
      `INSERT INTO messages (conversation_id, sender_id, id, kind, text, sent_at, status, attachment, media_state)
       VALUES (?, ?, ?, ?, ?, ?, 'received', ?, ?)`,
      conversationId,
      m.from,
      m.id,
      m.kind,
      m.text ?? null,
      m.sentAt,
      m.attachment ? JSON.stringify(m.attachment) : null,
      m.attachment ? 'remote' : null,
    );
    this.changed();
    return true;
  }

  async saveOutgoing(m: {
    to: string;
    id: string;
    kind?: string;
    text: string | null;
    sentAt: number;
    attachment?: StoredAttachment;
  }): Promise<void> {
    const kind = m.kind ?? 'text';
    const conversationId = await this.touchConversation(m.to, kind, m.text, m.sentAt, 0);
    await this.db.run(
      `INSERT INTO messages (conversation_id, sender_id, id, kind, text, sent_at, status, attachment, media_state)
       VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
      conversationId,
      this.myId(),
      m.id,
      kind,
      m.text,
      m.sentAt,
      m.attachment ? JSON.stringify(m.attachment) : null,
      m.attachment ? 'ready' : null,
    );
    this.changed();
  }

  /** Atualiza o anexo e/ou o estado da mídia de uma mensagem. */
  async setMedia(
    senderId: string,
    id: string,
    patch: { attachment?: StoredAttachment; mediaState?: MediaState },
  ): Promise<void> {
    if (patch.attachment) {
      await this.db.run(
        'UPDATE messages SET attachment = ? WHERE sender_id = ? AND id = ?',
        JSON.stringify(patch.attachment),
        senderId,
        id,
      );
    }
    if (patch.mediaState) {
      await this.db.run('UPDATE messages SET media_state = ? WHERE sender_id = ? AND id = ?', patch.mediaState, senderId, id);
    }
    this.changed();
  }

  async getMessage(senderId: string, id: string): Promise<Message | null> {
    const r = await this.db.first<MessageRow>(`SELECT ${MESSAGE_COLS} FROM messages WHERE sender_id = ? AND id = ?`, senderId, id);
    return r && this.toMessage(r);
  }

  private toMessage(r: MessageRow): Message {
    return {
      conversationId: r.conversation_id,
      senderId: r.sender_id,
      id: r.id,
      kind: r.kind,
      text: r.text,
      sentAt: r.sent_at,
      status: r.status,
      outgoing: r.sender_id === this.myId(),
      ...(r.attachment && { attachment: JSON.parse(r.attachment) as StoredAttachment }),
      ...(r.media_state && { mediaState: r.media_state }),
    };
  }

  async setOutgoingStatus(id: string, status: 'sent' | 'failed' | 'sending'): Promise<void> {
    await this.db.run('UPDATE messages SET status = ? WHERE sender_id = ? AND id = ?', status, this.myId(), id);
    this.changed();
  }

  async getOutgoing(id: string): Promise<{ to: string; text: string | null; kind: string } | null> {
    const r = await this.db.first<{ peer_id: string; text: string | null; kind: string }>(
      `SELECT c.peer_id, m.text, m.kind FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.sender_id = ? AND m.id = ?`,
      this.myId(),
      id,
    );
    return r && { to: r.peer_id, text: r.text, kind: r.kind };
  }

  async listConversations(): Promise<Conversation[]> {
    const rows = await this.db.all<{
      id: string;
      kind: 'direct' | 'group';
      peer_id: string;
      last_text: string | null;
      last_at: number;
      unread: number;
      username: string | null;
      display_name: string | null;
    }>(
      `SELECT c.id, c.kind, c.peer_id, c.last_text, c.last_at, c.unread, k.username, k.display_name
         FROM conversations c LEFT JOIN contacts k ON k.id = c.peer_id
        ORDER BY c.last_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      peerId: r.peer_id,
      title: contactTitle({ username: r.username, displayName: r.display_name }),
      lastText: r.last_text,
      lastAt: r.last_at,
      unread: r.unread,
    }));
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return (await this.listConversations()).find((c) => c.id === id) ?? null;
  }

  /** Mensagens da conversa, da mais recente para a mais antiga. */
  async listMessages(conversationId: string, limit = 200): Promise<Message[]> {
    const rows = await this.db.all<MessageRow>(
      `SELECT ${MESSAGE_COLS} FROM messages
        WHERE conversation_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT ?`,
      conversationId,
      limit,
    );
    return rows.map((r) => this.toMessage(r));
  }

  async markRead(conversationId: string): Promise<void> {
    await this.db.run('UPDATE conversations SET unread = 0 WHERE id = ? AND unread > 0', conversationId);
    this.changed();
  }

  /** Apaga todo o histórico local (logout / exclusão de conta). */
  async clear(): Promise<void> {
    await this.db.exec('DELETE FROM messages; DELETE FROM conversations; DELETE FROM contacts;');
    this.changed();
  }
}
