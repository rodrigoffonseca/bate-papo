// Histórico de conversas. Existe apenas no aparelho: o servidor apaga cada
// mensagem assim que ela é entregue.

import { newMessageId } from '@bate-papo/client';

import type { Sql } from './sql';

export type MessageStatus = 'sending' | 'sent' | 'failed' | 'received';

/**
 * Estado do arquivo de um anexo neste aparelho:
 * - ready: guardado (cifrado) no aparelho;
 * - remote: só no servidor (ainda não baixado);
 * - downloading: baixando;
 * - expired: o servidor já apagou e ele nunca foi baixado;
 * - error: falhou ao baixar (dá para tentar de novo);
 * - cleared: apagado do aparelho pela pessoa (dá para baixar de novo enquanto
 *   o servidor ainda tiver o arquivo).
 */
export type MediaState = 'ready' | 'remote' | 'downloading' | 'expired' | 'error' | 'cleared';

export type MediaKindName = 'image' | 'video' | 'voice';

/** Espaço ocupado pela mídia guardada no aparelho. */
export interface MediaUsage {
  totalBytes: number;
  byKind: Record<MediaKindName, { count: number; bytes: number }>;
  byConversation: { conversationId: string; title: string; count: number; bytes: number }[];
}

/** Filtro para listar/apagar mídia guardada. */
export interface MediaFilter {
  conversationId?: string;
  kinds?: MediaKindName[];
  /** Só mídia enviada/recebida antes deste instante (ms). */
  olderThan?: number;
}

export interface StoredMediaRef {
  conversationId: string;
  senderId: string;
  id: string;
  kind: MediaKindName;
  bytes: number;
  sentAt: number;
  /** Ainda não foi para o servidor: não pode ser apagada (seria a única cópia). */
  unsent: boolean;
}

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
  /** O contato (conversa direta) ou o grupo. */
  peerId: string;
  title: string;
  lastText: string | null;
  lastAt: number;
  unread: number;
  /** false se você saiu ou foi removido do grupo (o histórico fica). */
  active: boolean;
}

export type GroupRole = 'admin' | 'member';

export interface GroupMemberInfo {
  userId: string;
  role: GroupRole;
  name: string;
}

export interface LocalGroup {
  id: string;
  name: string;
  active: boolean;
  /** Ordenados: administradores primeiro, depois por nome. */
  members: GroupMemberInfo[];
}

/** Estado de um grupo como o servidor o descreve. */
export interface GroupSnapshot {
  id: string;
  name: string;
  created_by: string | null;
  members: { user_id: string; role: GroupRole }[];
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
  /** Nome de quem enviou (usado nos grupos). */
  senderName?: string;
}

/** Remetente dos avisos da conversa (ex.: "Maria entrou no grupo"). */
export const SYSTEM_SENDER = 'system';

export function directConversationId(userId: string): string {
  return `u:${userId}`;
}

export function groupConversationId(groupId: string): string {
  return `g:${groupId}`;
}

/** Para quem vão as mensagens de uma conversa. */
export function conversationTarget(conversationId: string): { userId: string } | { groupId: string } {
  const peer = conversationId.slice(2);
  if (conversationId.startsWith('u:')) return { userId: peer };
  if (conversationId.startsWith('g:')) return { groupId: peer };
  throw new Error('conversa inválida');
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

function quoted(name: string): string {
  return `“${name}”`;
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

  /** Contatos conhecidos (exceto você), por nome. */
  async listContacts(): Promise<Contact[]> {
    const rows = await this.db.all<{ id: string; username: string | null; display_name: string | null }>(
      'SELECT id, username, display_name FROM contacts WHERE id != ?',
      this.myId(),
    );
    return rows
      .map((r) => ({ id: r.id, username: r.username, displayName: r.display_name }))
      .sort((a, b) => contactTitle(a).localeCompare(contactTitle(b), 'pt-BR'));
  }

  private async touchConversation(conversationId: string, kind: string, text: string | null, at: number, unread: number) {
    const target = conversationTarget(conversationId);
    await this.db.run(
      `INSERT INTO conversations (id, kind, peer_id, last_text, last_at, unread) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         last_text = CASE WHEN excluded.last_at >= conversations.last_at THEN excluded.last_text ELSE conversations.last_text END,
         last_at   = MAX(conversations.last_at, excluded.last_at),
         unread    = conversations.unread + excluded.unread`,
      conversationId,
      'groupId' in target ? 'group' : 'direct',
      'groupId' in target ? target.groupId : target.userId,
      preview(kind, text),
      at,
      unread,
    );
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
    m: {
      from: string;
      id: string;
      kind: string;
      text?: string;
      sentAt: number;
      attachment?: StoredAttachment;
      groupId?: string;
    },
    opts: { read: boolean },
  ): Promise<boolean> {
    const exists = await this.db.first('SELECT 1 FROM messages WHERE sender_id = ? AND id = ?', m.from, m.id);
    if (exists) return false;
    const conversationId = m.groupId ? groupConversationId(m.groupId) : directConversationId(m.from);
    await this.touchConversation(conversationId, m.kind, m.text ?? null, m.sentAt, opts.read ? 0 : 1);
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
    conversationId: string;
    id: string;
    kind?: string;
    text: string | null;
    sentAt: number;
    attachment?: StoredAttachment;
  }): Promise<void> {
    const kind = m.kind ?? 'text';
    await this.touchConversation(m.conversationId, kind, m.text, m.sentAt, 0);
    await this.db.run(
      `INSERT INTO messages (conversation_id, sender_id, id, kind, text, sent_at, status, attachment, media_state)
       VALUES (?, ?, ?, ?, ?, ?, 'sending', ?, ?)`,
      m.conversationId,
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

  private toMessage(r: MessageRow & { username?: string | null; display_name?: string | null }): Message {
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
      ...(r.username !== undefined &&
        r.sender_id !== SYSTEM_SENDER && { senderName: contactTitle({ username: r.username, displayName: r.display_name ?? null }) }),
    };
  }

  async setOutgoingStatus(id: string, status: 'sent' | 'failed' | 'sending'): Promise<void> {
    await this.db.run('UPDATE messages SET status = ? WHERE sender_id = ? AND id = ?', status, this.myId(), id);
    this.changed();
  }

  async getOutgoing(id: string): Promise<{ conversationId: string; text: string | null; kind: string } | null> {
    const r = await this.db.first<{ conversation_id: string; text: string | null; kind: string }>(
      'SELECT conversation_id, text, kind FROM messages WHERE sender_id = ? AND id = ?',
      this.myId(),
      id,
    );
    return r && { conversationId: r.conversation_id, text: r.text, kind: r.kind };
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
      group_name: string | null;
      group_active: number | null;
    }>(
      `SELECT c.id, c.kind, c.peer_id, c.last_text, c.last_at, c.unread, k.username, k.display_name,
              g.name AS group_name, g.active AS group_active
         FROM conversations c
         LEFT JOIN contacts k ON c.kind = 'direct' AND k.id = c.peer_id
         LEFT JOIN groups g ON c.kind = 'group' AND g.id = c.peer_id
        ORDER BY c.last_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      peerId: r.peer_id,
      title: r.kind === 'group' ? (r.group_name ?? 'Grupo') : contactTitle({ username: r.username, displayName: r.display_name }),
      lastText: r.last_text,
      lastAt: r.last_at,
      unread: r.unread,
      active: r.kind === 'direct' || r.group_active === 1,
    }));
  }

  async getConversation(id: string): Promise<Conversation | null> {
    return (await this.listConversations()).find((c) => c.id === id) ?? null;
  }

  /** Mensagens da conversa, da mais recente para a mais antiga. */
  async listMessages(conversationId: string, limit = 200): Promise<Message[]> {
    const cols = MESSAGE_COLS.split(', ')
      .map((c) => `m.${c}`)
      .join(', ');
    const rows = await this.db.all<MessageRow & { username: string | null; display_name: string | null }>(
      `SELECT ${cols}, k.username, k.display_name FROM messages m
         LEFT JOIN contacts k ON k.id = m.sender_id
        WHERE m.conversation_id = ? ORDER BY m.sent_at DESC, m.rowid DESC LIMIT ?`,
      conversationId,
      limit,
    );
    return rows.map((r) => this.toMessage(r));
  }

  /** Mídia guardada no aparelho que atende ao filtro. */
  async listStoredMedia(f: MediaFilter = {}): Promise<StoredMediaRef[]> {
    const where = ["m.media_state = 'ready'", "m.kind IN ('image', 'video', 'voice')"];
    const params: (string | number)[] = [];
    if (f.conversationId) {
      where.push('m.conversation_id = ?');
      params.push(f.conversationId);
    }
    if (f.kinds?.length) {
      where.push(`m.kind IN (${f.kinds.map(() => '?').join(', ')})`);
      params.push(...f.kinds);
    }
    if (f.olderThan !== undefined) {
      where.push('m.sent_at < ?');
      params.push(f.olderThan);
    }
    const rows = await this.db.all<{
      conversation_id: string;
      sender_id: string;
      id: string;
      kind: MediaKindName;
      attachment: string;
      sent_at: number;
    }>(
      `SELECT m.conversation_id, m.sender_id, m.id, m.kind, m.attachment, m.sent_at FROM messages m
        WHERE ${where.join(' AND ')} ORDER BY m.sent_at`,
      ...params,
    );
    return rows.map((r) => {
      const a = JSON.parse(r.attachment) as StoredAttachment;
      return {
        conversationId: r.conversation_id,
        senderId: r.sender_id,
        id: r.id,
        kind: r.kind,
        bytes: a.size,
        sentAt: r.sent_at,
        unsent: !a.id,
      };
    });
  }

  /** Quanto espaço a mídia ocupa, por tipo e por conversa. */
  async mediaUsage(): Promise<MediaUsage> {
    const items = await this.listStoredMedia();
    const byKind: MediaUsage['byKind'] = {
      image: { count: 0, bytes: 0 },
      video: { count: 0, bytes: 0 },
      voice: { count: 0, bytes: 0 },
    };
    for (const it of items) {
      byKind[it.kind].count++;
      byKind[it.kind].bytes += it.bytes;
    }
    const titles = new Map((await this.listConversations()).map((c) => [c.id, c.title]));
    const perConversation = new Map<string, { count: number; bytes: number }>();
    for (const it of items) {
      const c = perConversation.get(it.conversationId) ?? { count: 0, bytes: 0 };
      c.count++;
      c.bytes += it.bytes;
      perConversation.set(it.conversationId, c);
    }
    const byConversation = [...perConversation]
      .map(([conversationId, c]) => ({ conversationId, title: titles.get(conversationId) ?? 'Conversa', ...c }))
      .sort((x, y) => y.bytes - x.bytes);
    return { totalBytes: items.reduce((s, it) => s + it.bytes, 0), byKind, byConversation };
  }

  // ---- grupos ----

  async getGroup(id: string): Promise<LocalGroup | null> {
    const g = await this.db.first<{ id: string; name: string; active: number }>(
      'SELECT id, name, active FROM groups WHERE id = ?',
      id,
    );
    if (!g) return null;
    const rows = await this.db.all<{ user_id: string; role: GroupRole; username: string | null; display_name: string | null }>(
      `SELECT m.user_id, m.role, k.username, k.display_name FROM group_members m
         LEFT JOIN contacts k ON k.id = m.user_id WHERE m.group_id = ?`,
      id,
    );
    const members = rows
      .map((r) => ({ userId: r.user_id, role: r.role, name: this.memberName(r.user_id, r) }))
      .sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name, 'pt-BR') : a.role === 'admin' ? -1 : 1));
    return { id: g.id, name: g.name, active: g.active === 1, members };
  }

  /** IDs dos grupos de que você faz parte, segundo a cópia local. */
  async activeGroupIds(): Promise<string[]> {
    return (await this.db.all<{ id: string }>('SELECT id FROM groups WHERE active = 1')).map((r) => r.id);
  }

  private memberName(userId: string, c: { username: string | null; display_name: string | null } | null): string {
    if (userId === this.myId()) return 'Você';
    return contactTitle(c && { username: c.username, displayName: c.display_name });
  }

  private async nameOf(userId: string): Promise<string> {
    const c = await this.db.first<{ username: string | null; display_name: string | null }>(
      'SELECT username, display_name FROM contacts WHERE id = ?',
      userId,
    );
    return this.memberName(userId, c);
  }

  /** Registra um aviso na conversa (não conta como não lido). */
  private async notice(conversationId: string, text: string, at: number): Promise<void> {
    await this.touchConversation(conversationId, 'system', text, at, 0);
    await this.db.run(
      `INSERT INTO messages (conversation_id, sender_id, id, kind, text, sent_at, status)
       VALUES (?, ?, ?, 'system', ?, ?, 'received')`,
      conversationId,
      SYSTEM_SENDER,
      newMessageId(),
      text,
      at,
    );
  }

  /**
   * Guarda o estado atual do grupo e registra na conversa o que mudou desde a
   * última vez (quem entrou, quem saiu, novo nome, administradores). Assim
   * ninguém entra no grupo sem que todos vejam. Os contatos dos membros devem
   * ser gravados antes, para os avisos saírem com os nomes.
   */
  async saveGroup(g: GroupSnapshot, at: number): Promise<void> {
    const conversationId = groupConversationId(g.id);
    const before = await this.getGroup(g.id);
    const me = this.myId();
    const notices: string[] = [];
    if (!before) {
      notices.push(g.created_by === me ? `Você criou o grupo ${quoted(g.name)}` : `Você entrou no grupo ${quoted(g.name)}`);
    } else {
      if (!before.active) notices.push('Você voltou ao grupo');
      if (before.name !== g.name) notices.push(`O nome do grupo mudou para ${quoted(g.name)}`);
      const old = new Map(before.active ? before.members.map((m) => [m.userId, m.role]) : []);
      const now = new Map(g.members.map((m) => [m.user_id, m.role]));
      for (const [id, role] of now) {
        if (id === me) {
          if (old.has(id) && old.get(id) !== role) {
            notices.push(role === 'admin' ? 'Agora você é administrador(a) do grupo' : 'Você não é mais administrador(a) do grupo');
          }
          continue;
        }
        const name = await this.nameOf(id);
        if (!old.has(id)) notices.push(`${name} entrou no grupo`);
        else if (old.get(id) !== role) notices.push(role === 'admin' ? `${name} agora é administrador(a)` : `${name} não é mais administrador(a)`);
      }
      for (const id of old.keys()) {
        if (!now.has(id) && id !== me) notices.push(`${await this.nameOf(id)} saiu do grupo`);
      }
    }
    await this.db.run(
      `INSERT INTO groups (id, name, active, updated_at) VALUES (?, ?, 1, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, active = 1, updated_at = excluded.updated_at`,
      g.id,
      g.name,
      at,
    );
    await this.db.run('DELETE FROM group_members WHERE group_id = ?', g.id);
    for (const m of g.members) {
      await this.db.run('INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)', g.id, m.user_id, m.role);
    }
    for (const text of notices) await this.notice(conversationId, text, at);
    this.changed();
  }

  /** Você saiu ou foi removido: o histórico fica, mas não dá mais para enviar. */
  async deactivateGroup(id: string, at: number, reason: 'left' | 'removed'): Promise<void> {
    const g = await this.getGroup(id);
    if (!g?.active) return;
    await this.db.run('UPDATE groups SET active = 0, updated_at = ? WHERE id = ?', at, id);
    await this.db.run('DELETE FROM group_members WHERE group_id = ?', id);
    await this.notice(groupConversationId(id), reason === 'left' ? 'Você saiu do grupo' : 'Você não faz mais parte deste grupo', at);
    this.changed();
  }

  async markRead(conversationId: string): Promise<void> {
    await this.db.run('UPDATE conversations SET unread = 0 WHERE id = ? AND unread > 0', conversationId);
    this.changed();
  }

  /** Apaga todo o histórico local (logout / exclusão de conta). */
  async clear(): Promise<void> {
    await this.db.exec(
      'DELETE FROM messages; DELETE FROM conversations; DELETE FROM group_members; DELETE FROM groups; DELETE FROM contacts;',
    );
    this.changed();
  }
}
