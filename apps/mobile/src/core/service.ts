// Estado e regras do app, sem dependência de React Native: as telas apenas
// observam este serviço. Assim ele pode ser testado no Node contra o
// servidor de verdade.

import {
  ApiError,
  BatePapoClient,
  type FetchLike,
  KeyValueStorage,
  type ReceivedMessage,
  type User,
  newMessageId,
} from '@bate-papo/client';

import { type Contact, History, directConversationId } from './history';
import { SqlKV } from './kv';
import { type Sql, migrate } from './sql';

export type Phase = 'loading' | 'signed-out' | 'needs-profile' | 'ready';

export interface AppState {
  phase: Phase;
  me: User | null;
  online: boolean;
  /** Último alerta de troca de chave de segurança, para a interface avisar. */
  identityAlert: { userId: string; at: number } | null;
}

export interface ServiceDeps {
  db: Sql;
  serverUrl: string;
  fetch?: FetchLike;
}

const ME_KEY = 'app:me';
/** Tolerância para relógios adiantados de outros aparelhos. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export class AppService {
  readonly history: History;
  private client!: BatePapoClient;
  private storage!: KeyValueStorage;
  private kv!: SqlKV;
  private state: AppState = { phase: 'loading', me: null, online: false, identityAlert: null };
  private readonly listeners = new Set<() => void>();
  private activeConversation: string | null = null;
  private unsubscribers: (() => void)[] = [];

  constructor(private readonly deps: ServiceDeps) {
    this.history = new History(deps.db, () => this.state.me?.id ?? '');
  }

  // ---- observação (useSyncExternalStore) ----

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getState = (): AppState => this.state;

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  // ---- ciclo de vida ----

  async init(): Promise<void> {
    await migrate(this.deps.db);
    this.kv = new SqlKV(this.deps.db);
    this.storage = new KeyValueStorage(this.kv);
    this.newClient();

    if (!(await this.client.restore())) {
      this.set({ phase: 'signed-out' });
      return;
    }
    const cached = await this.kv.get(ME_KEY);
    let me: User | null = cached ? (JSON.parse(cached) as User) : null;
    try {
      me = await this.client.api.me();
      await this.kv.set(ME_KEY, JSON.stringify(me));
    } catch (err) {
      // Sessão encerrada (ex.: o número foi cadastrado em outro aparelho).
      if (err instanceof ApiError && err.status === 401) {
        await this.wipe();
        return;
      }
      // Sem rede: segue com o perfil guardado.
    }
    if (!me) {
      this.set({ phase: 'signed-out' });
      return;
    }
    this.enter(me);
  }

  private newClient(): void {
    for (const u of this.unsubscribers) u();
    this.client = new BatePapoClient({
      serverUrl: this.deps.serverUrl,
      storage: this.storage,
      fetch: this.deps.fetch,
    });
    this.unsubscribers = [
      this.client.on('message', (m) => void this.onMessage(m)),
      this.client.on('connection', (c) => this.set({ online: c === 'connected' })),
      this.client.on('identityChanged', (c) => this.set({ identityAlert: { userId: c.userId, at: Date.now() } })),
    ];
  }

  private enter(me: User): void {
    this.set({ me, phase: me.username ? 'ready' : 'needs-profile' });
    this.client.connect();
  }

  /** Para quando o app vai para segundo plano. */
  pause(): void {
    this.client?.disconnect();
  }

  resume(): void {
    if (this.state.phase === 'ready' || this.state.phase === 'needs-profile') this.client.connect();
  }

  // ---- cadastro ----

  requestCode(phone: string) {
    return this.client.requestCode(phone);
  }

  async verifyCode(phone: string, code: string): Promise<void> {
    // Um número novo neste aparelho não deve herdar o histórico de outra conta.
    const previous = (await this.client.restore()) ? this.client.currentUserId : null;
    const { user } = await this.client.verifyCode(phone, code);
    if (previous && previous !== user.id) await this.history.clear();
    await this.kv.set(ME_KEY, JSON.stringify(user));
    this.enter(user);
  }

  async saveProfile(fields: { username: string; displayName: string }): Promise<void> {
    const me = await this.client.setProfile(fields);
    await this.kv.set(ME_KEY, JSON.stringify(me));
    this.set({ me, phase: me.username ? 'ready' : 'needs-profile' });
  }

  async logout(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // Mesmo sem rede, apaga os dados locais.
    }
    await this.wipe();
  }

  async deleteAccount(): Promise<void> {
    await this.client.deleteAccount();
    await this.wipe();
  }

  private async wipe(): Promise<void> {
    this.client.disconnect();
    await this.storage.clear();
    await this.history.clear();
    this.newClient();
    this.set({ phase: 'signed-out', me: null, online: false, identityAlert: null });
  }

  // ---- contatos e conversas ----

  /** Busca um contato pelo @nome e abre (ou cria) a conversa com ele. */
  async startConversation(username: string): Promise<string> {
    const user = await this.client.findByUsername(username.trim());
    if (user.id === this.state.me?.id) throw new Error('Esse é você 🙂');
    await this.history.upsertContact(toContact(user));
    return this.history.ensureDirectConversation(user.id);
  }

  setActiveConversation(id: string | null): void {
    this.activeConversation = id;
    if (id) void this.history.markRead(id);
  }

  async sendText(peerId: string, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    const id = newMessageId();
    await this.history.saveOutgoing({ to: peerId, id, text: body, sentAt: Date.now() });
    await this.deliver(peerId, id, body);
  }

  /** Tenta reenviar uma mensagem que falhou. */
  async retry(id: string): Promise<void> {
    const m = await this.history.getOutgoing(id);
    if (!m) return;
    await this.history.setOutgoingStatus(id, 'sending');
    await this.deliver(m.to, id, m.text);
  }

  private async deliver(peerId: string, id: string, text: string): Promise<void> {
    try {
      await this.client.sendText({ userId: peerId }, text, { id });
      await this.history.setOutgoingStatus(id, 'sent');
    } catch {
      await this.history.setOutgoingStatus(id, 'failed');
    }
  }

  private async onMessage(m: ReceivedMessage): Promise<void> {
    // Fatia 1: apenas conversas 1:1 de texto. Grupos, fotos e áudios chegam
    // nas próximas fatias.
    if (m.groupId) return;
    if (!(await this.history.getContact(m.from))) {
      try {
        await this.history.upsertContact(toContact(await this.client.api.getUser(m.from)));
      } catch {
        // Sem rede: o nome aparece depois.
      }
    }
    const sentAt = Math.min(m.sentAt, Date.now() + MAX_CLOCK_SKEW_MS);
    await this.history.saveIncoming(
      { from: m.from, id: m.id, kind: m.kind, text: m.text, sentAt },
      { read: this.activeConversation === directConversationId(m.from) },
    );
  }

  /** Número de segurança da conversa com um contato. */
  safetyNumber(peerId: string) {
    return this.client.safetyNumber(peerId);
  }
}

function toContact(u: User): Contact {
  return { id: u.id, username: u.username, displayName: u.display_name };
}
