// Histórico de conversas. Existe apenas no aparelho: o servidor apaga cada
// mensagem assim que ela é entregue.

import type { Sql } from './sql';

export type MessageStatus = 'sending' | 'sent' | 'failed' | 'received';

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
  if (kind === 'voice') return '🎤 Mensagem de voz';
  return text ?? '';
}

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
    m: { from: string; id: string; kind: string; text?: string; sentAt: number },
    opts: { read: boolean },
  ): Promise<boolean> {
    const exists = await this.db.first('SELECT 1 FROM messages WHERE sender_id = ? AND id = ?', m.from, m.id);
    if (exists) return false;
    const conversationId = await this.touchConversation(m.from, m.kind, m.text ?? null, m.sentAt, opts.read ? 0 : 1);
    await this.db.run(
      `INSERT INTO messages (conversation_id, sender_id, id, kind, text, sent_at, status)
       VALUES (?, ?, ?, ?, ?, ?, 'received')`,
      conversationId,
      m.from,
      m.id,
      m.kind,
      m.text ?? null,
      m.sentAt,
    );
    this.changed();
    return true;
  }

  async saveOutgoing(m: { to: string; id: string; text: string; sentAt: number }): Promise<void> {
    const conversationId = await this.touchConversation(m.to, 'text', m.text, m.sentAt, 0);
    await this.db.run(
      `INSERT INTO messages (conversation_id, sender_id, id, kind, text, sent_at, status)
       VALUES (?, ?, ?, 'text', ?, ?, 'sending')`,
      conversationId,
      this.myId(),
      m.id,
      m.text,
      m.sentAt,
    );
    this.changed();
  }

  async setOutgoingStatus(id: string, status: 'sent' | 'failed' | 'sending'): Promise<void> {
    await this.db.run('UPDATE messages SET status = ? WHERE sender_id = ? AND id = ?', status, this.myId(), id);
    this.changed();
  }

  async getOutgoing(id: string): Promise<{ to: string; text: string } | null> {
    const r = await this.db.first<{ peer_id: string; text: string }>(
      `SELECT c.peer_id, m.text FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE m.sender_id = ? AND m.id = ?`,
      this.myId(),
      id,
    );
    return r && { to: r.peer_id, text: r.text };
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
    const rows = await this.db.all<{
      conversation_id: string;
      sender_id: string;
      id: string;
      kind: string;
      text: string | null;
      sent_at: number;
      status: MessageStatus;
    }>(
      `SELECT conversation_id, sender_id, id, kind, text, sent_at, status FROM messages
        WHERE conversation_id = ? ORDER BY sent_at DESC, rowid DESC LIMIT ?`,
      conversationId,
      limit,
    );
    const me = this.myId();
    return rows.map((r) => ({
      conversationId: r.conversation_id,
      senderId: r.sender_id,
      id: r.id,
      kind: r.kind,
      text: r.text,
      sentAt: r.sent_at,
      status: r.status,
      outgoing: r.sender_id === me,
    }));
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
