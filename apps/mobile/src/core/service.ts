// Estado e regras do app, sem dependência de React Native: as telas apenas
// observam este serviço. Assim ele pode ser testado no Node contra o
// servidor de verdade.

import { decryptAttachment, encryptAttachment, fromBase64, toBase64 } from '@bate-papo/crypto';
import {
  type AccountAlert,
  ApiError,
  AttachmentExpiredError,
  type MediaKind,
  BatePapoClient,
  type PushKind,
  PushUnavailableError,
  type FetchLike,
  type Group,
  KeyValueStorage,
  type ReceivedMessage,
  type User,
  newMessageId,
} from '@bate-papo/client';

import {
  type Contact,
  History,
  type MediaFilter,
  type Message,
  type StoredAttachment,
  conversationTarget,
  directConversationId,
  groupConversationId,
} from './history';
import { type MediaStore, extensionFor, mediaKey } from './media';
import { type VerificationState, parseSafetyQr } from './safety';
import { SqlKV } from './kv';
import { type Sql, migrate } from './sql';

/**
 * Etapas: sem login → perfil → PIN de bloqueio → pronto.
 * O PIN é obrigatório: sem ele, quem clonar o chip assume a conta.
 */
export type Phase = 'loading' | 'signed-out' | 'needs-profile' | 'needs-pin' | 'ready';

export interface AppState {
  phase: Phase;
  me: User | null;
  online: boolean;
  /** Último alerta de troca de chave de segurança, para a interface avisar. */
  identityAlert: { userId: string; at: number } | null;
  /** Alertas de segurança da conta ainda não vistos (ex.: tentativa de registro). */
  accountAlerts: AccountAlert[];
  /** Código de recuperação recém-gerado, mostrado uma única vez. */
  recoveryCode: string | null;
  /** Hora de pedir ao usuário que confirme o PIN, para não esquecê-lo. */
  pinReminderDue: boolean;
  /** Por que a sessão terminou sem o usuário sair (ex.: registro em outro aparelho). */
  signedOutReason: 'session-ended' | null;
  /** Limpeza automática de mídia: apaga do aparelho o que tiver mais de N dias (0 = desligada). */
  autoCleanupDays: number;
  /** Muda quando alguma verificação de contato muda (para as telas atualizarem). */
  verificationVersion: number;
  /**
   * Notificações:
   * - on: ligadas (o aviso não mostra o texto nem quem enviou);
   * - off: desligadas pela pessoa;
   * - denied: bloqueadas nos ajustes do celular;
   * - unavailable: o servidor (ou esta versão do app) não envia notificações.
   */
  notifications: NotificationsState;
}

export type NotificationsState = 'on' | 'off' | 'denied' | 'unavailable';

/** Notificações do sistema (no app, expo-notifications; nos testes, um substituto). */
export interface PushPlatform {
  /** Pede permissão, se preciso, e devolve o token deste aparelho; null se a pessoa negou. */
  getToken(): Promise<{ kind: PushKind; token: string } | null>;
  /** Avisa quando o sistema troca o token. */
  onTokenChange?(fn: (t: { kind: PushKind; token: string }) => void): () => void;
}

export interface ServiceDeps {
  db: Sql;
  /** Onde ficam os arquivos de mídia (cifrados). */
  media: MediaStore;
  serverUrl: string;
  fetch?: FetchLike;
  /** Relógio (substituível nos testes). */
  now?: () => number;
  /** Notificações push (ausente = indisponível). */
  push?: PushPlatform;
}

/** Limites de tamanho por tipo, antes de cifrar (o servidor aceita até 64 MiB). */
export const MEDIA_LIMITS: Record<MediaKind, number> = {
  image: 25 * 1024 * 1024,
  video: 60 * 1024 * 1024,
  voice: 16 * 1024 * 1024,
};
/** Fotos e áudios até este tamanho são baixados assim que chegam; vídeos, só com um toque. */
const AUTO_DOWNLOAD_BYTES = 8 * 1024 * 1024;

/** Você saiu ou foi removido do grupo. */
export class NotGroupMemberError extends Error {
  constructor() {
    super('Você não faz mais parte deste grupo');
    this.name = 'NotGroupMemberError';
  }
}

export class MediaTooLargeError extends Error {
  constructor(readonly kind: MediaKind, readonly limit: number) {
    super(`arquivo grande demais (máximo ${Math.round(limit / 1024 / 1024)} MB)`);
    this.name = 'MediaTooLargeError';
  }
}

/** Foto, vídeo ou áudio escolhido ou gravado pela pessoa, já lido do arquivo. */
export interface MediaInput {
  kind: MediaKind;
  bytes: Uint8Array;
  mime: string;
  width?: number;
  height?: number;
  durationMs?: number;
  /** Miniatura JPEG pequena em base64 (fotos e vídeos). */
  thumbnail?: string;
  caption?: string;
}

const ME_KEY = 'app:me';
const PIN_KEY = 'app:pin-enabled';
const PIN_CHECKED_KEY = 'app:pin-checked-at';
/** Intervalo do lembrete do PIN. */
export const PIN_REMINDER_MS = 14 * 24 * 60 * 60 * 1000;
/** Tolerância para relógios adiantados de outros aparelhos. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const INITIAL: AppState = {
  phase: 'loading',
  me: null,
  online: false,
  identityAlert: null,
  accountAlerts: [],
  recoveryCode: null,
  pinReminderDue: false,
  signedOutReason: null,
  autoCleanupDays: 0,
  verificationVersion: 0,
  notifications: 'off',
};

/** Opções oferecidas na tela de armazenamento (0 = desligada). */
export const AUTO_CLEANUP_OPTIONS = [0, 30, 90, 365] as const;
const AUTO_CLEANUP_KEY = 'app:auto-cleanup-days';
/** A pessoa desligou as notificações neste aparelho. */
const NOTIFICATIONS_OFF_KEY = 'app:notifications-off';
/** Chave de identidade do contato no momento em que foi verificado. */
const VERIFIED_KEY = 'app:verified:';
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CleanupResult {
  /** Arquivos apagados do aparelho. */
  count: number;
  bytes: number;
  /** Mídia ainda não enviada, que não pode ser apagada (seria a única cópia). */
  skipped: number;
}

export class AppService {
  readonly history: History;
  private client!: BatePapoClient;
  private storage!: KeyValueStorage;
  private kv!: SqlKV;
  private state: AppState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private activeConversation: string | null = null;
  private unsubscribers: (() => void)[] = [];
  private stopTokenListener: (() => void) | null = null;
  private readonly now: () => number;
  /** Atualizações de grupo uma de cada vez, para não registrar a mesma mudança duas vezes. */
  private groupQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ServiceDeps) {
    this.history = new History(deps.db, () => this.state.me?.id ?? '');
    this.now = deps.now ?? Date.now;
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
    // Arquivos decifrados que sobraram de uma execução anterior.
    await this.deps.media.clearTemp().catch(() => undefined);
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
      // Sessão encerrada: o número foi registrado em outro aparelho, a sessão
      // expirou por inatividade ou a conta foi apagada.
      if (err instanceof ApiError && err.status === 401) {
        await this.wipe('session-ended');
        return;
      }
      // Sem rede: segue com o perfil guardado.
    }
    if (!me) {
      this.set({ phase: 'signed-out' });
      return;
    }
    await this.enter(me);
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
      this.client.on('connection', (c) => {
        this.set({ online: c === 'connected' });
        // Ao (re)conectar, confere os grupos: alguém pode ter sido incluído ou
        // removido enquanto o app estava fechado.
        if (c === 'connected') void this.syncGroups().catch(() => undefined);
      }),
      this.client.on('groupChanged', ({ groupId }) => void this.refreshGroup(groupId).catch(() => undefined)),
      this.client.on('identityChanged', (c) => this.set({ identityAlert: { userId: c.userId, at: this.now() } })),
      this.client.on('accountAlert', (a) => {
        if (!this.state.accountAlerts.some((x) => x.id === a.id)) {
          this.set({ accountAlerts: [a, ...this.state.accountAlerts] });
        }
      }),
    ];
  }

  private async enter(me: User): Promise<void> {
    let pin = (await this.kv.get(PIN_KEY)) === 'true';
    try {
      pin = await this.client.pinEnabled();
      await this.kv.set(PIN_KEY, String(pin));
      this.set({ accountAlerts: await this.client.accountAlerts() });
    } catch {
      // Sem rede: usa o que estiver guardado.
    }
    this.set({ me, signedOutReason: null });
    await this.updatePhase(pin);
    this.client.connect();
    await this.runAutoCleanup();
  }

  private async updatePhase(pinEnabled: boolean): Promise<void> {
    const me = this.state.me;
    if (!me?.username) return this.set({ phase: 'needs-profile' });
    if (!pinEnabled) return this.set({ phase: 'needs-pin' });
    const checked = Number((await this.kv.get(PIN_CHECKED_KEY)) ?? 0);
    const wasReady = this.state.phase === 'ready';
    this.set({ phase: 'ready', pinReminderDue: this.now() - checked > PIN_REMINDER_MS });
    if (!wasReady) void this.syncNotifications();
  }

  // ---- notificações ----

  /** Liga ou desliga as notificações deste aparelho. */
  async setNotifications(enabled: boolean): Promise<NotificationsState> {
    if (enabled) {
      await this.kv.delete(NOTIFICATIONS_OFF_KEY);
      return this.syncNotifications();
    }
    await this.kv.set(NOTIFICATIONS_OFF_KEY, 'true');
    this.stopTokenListener?.();
    this.stopTokenListener = null;
    this.set({ notifications: 'off' });
    await this.client.unregisterPush().catch(() => undefined);
    return 'off';
  }

  /**
   * Registra no servidor o token de push deste aparelho (a menos que a pessoa
   * tenha desligado as notificações). Chamado ao entrar no app.
   */
  private async syncNotifications(): Promise<NotificationsState> {
    let state: NotificationsState;
    if (!this.deps.push) state = 'unavailable';
    else if (await this.kv.get(NOTIFICATIONS_OFF_KEY)) state = 'off';
    else {
      try {
        const t = await this.deps.push.getToken();
        if (!t) state = 'denied';
        else {
          await this.client.registerPush(t.kind, t.token);
          state = 'on';
          this.stopTokenListener ??=
            this.deps.push.onTokenChange?.((n) => void this.client.registerPush(n.kind, n.token).catch(() => undefined)) ??
            null;
        }
      } catch (err) {
        // Sem rede, o estado atual continua; tenta de novo na próxima entrada.
        if (err instanceof PushUnavailableError) state = 'unavailable';
        else if (err instanceof ApiError || isNetworkError(err)) state = this.state.notifications;
        else state = 'unavailable'; // ex.: Firebase não configurado nesta versão do app
      }
    }
    this.set({ notifications: state });
    return state;
  }

  /** Para quando o app vai para segundo plano. */
  pause(): void {
    this.client?.disconnect();
  }

  resume(): void {
    if (this.state.me) this.client.connect();
  }

  // ---- cadastro ----

  requestCode(phone: string) {
    return this.client.requestCode(phone);
  }

  /**
   * Confirma o código SMS. Se a conta tiver PIN, lança
   * RegistrationLockedError: a interface pede o PIN e chama unlock().
   */
  async verifyCode(phone: string, code: string): Promise<void> {
    const previous = await this.previousUser();
    const { user } = await this.client.verifyCode(phone, code);
    await this.registered(user, previous);
  }

  /** Conclui o registro de uma conta protegida, com o PIN ou o código de recuperação. */
  async unlock(lockToken: string, secret: { pin: string } | { recoveryCode: string }): Promise<void> {
    const previous = await this.previousUser();
    const { user } = await this.client.unlock(lockToken, secret);
    // Quem acabou de digitar o PIN certo não precisa do lembrete.
    if ('pin' in secret) await this.kv.set(PIN_CHECKED_KEY, String(this.now()));
    await this.registered(user, previous);
  }

  private async previousUser(): Promise<string | null> {
    return (await this.client.restore()) ? this.client.currentUserId : null;
  }

  private async registered(user: User, previous: string | null): Promise<void> {
    // Um número novo neste aparelho não deve herdar o histórico de outra conta.
    if (previous && previous !== user.id) await this.history.clear();
    await this.kv.set(ME_KEY, JSON.stringify(user));
    await this.enter(user);
  }

  async saveProfile(fields: { username: string; displayName: string }): Promise<void> {
    const me = await this.client.setProfile(fields);
    await this.kv.set(ME_KEY, JSON.stringify(me));
    this.set({ me });
    await this.updatePhase((await this.kv.get(PIN_KEY)) === 'true');
  }

  // ---- segurança da conta ----

  /**
   * Define (ou troca) o PIN. O novo código de recuperação fica em
   * state.recoveryCode até o usuário confirmar que o guardou.
   */
  async setPin(pin: string): Promise<void> {
    const recoveryCode = await this.client.setPin(pin);
    await this.kv.set(PIN_KEY, 'true');
    await this.kv.set(PIN_CHECKED_KEY, String(this.now()));
    this.set({ recoveryCode, pinReminderDue: false });
  }

  /** Gera um novo código de recuperação (o anterior deixa de valer). */
  async newRecoveryCode(): Promise<void> {
    this.set({ recoveryCode: await this.client.newRecoveryCode() });
  }

  /** O usuário guardou o código de recuperação: ele some da memória do app. */
  async recoveryCodeSaved(): Promise<void> {
    this.set({ recoveryCode: null });
    await this.updatePhase(true);
  }

  /** Lembrete periódico: confere o PIN. Devolve false se estiver errado. */
  async confirmPin(pin: string): Promise<boolean> {
    const ok = await this.client.checkPin(pin);
    if (ok) {
      await this.kv.set(PIN_CHECKED_KEY, String(this.now()));
      this.set({ pinReminderDue: false });
    }
    return ok;
  }

  async dismissAccountAlerts(): Promise<void> {
    const ids = this.state.accountAlerts.map((a) => a.id);
    this.set({ accountAlerts: [] });
    if (ids.length) await this.client.ackAccountAlerts(ids).catch(() => undefined);
  }

  async logout(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // Mesmo sem rede, apaga os dados locais.
    }
    await this.wipe(null);
  }

  async deleteAccount(): Promise<void> {
    await this.client.deleteAccount();
    await this.wipe(null);
  }

  private async wipe(reason: AppState['signedOutReason']): Promise<void> {
    this.client.disconnect();
    this.stopTokenListener?.();
    this.stopTokenListener = null;
    await this.storage.clear();
    await this.history.clear();
    await this.deps.media.clear();
    this.newClient();
    this.set({ ...INITIAL, phase: 'signed-out', signedOutReason: reason });
  }

  // ---- contatos e conversas ----

  /** Busca um contato pelo @nome e abre (ou cria) a conversa com ele. */
  async startConversation(username: string): Promise<string> {
    const contact = await this.findUser(username);
    return this.history.ensureDirectConversation(contact.id);
  }

  /** Abre (ou cria) a conversa direta com um contato já conhecido. */
  openDirectConversation(userId: string): Promise<string> {
    return this.history.ensureDirectConversation(userId);
  }

  setActiveConversation(id: string | null): void {
    this.activeConversation = id;
    if (id) void this.history.markRead(id);
  }

  /** Envia um texto na conversa (direta ou de grupo). */
  async sendText(conversationId: string, text: string): Promise<void> {
    const body = text.trim();
    if (!body) return;
    await this.assertCanSend(conversationId);
    const id = newMessageId();
    await this.history.saveOutgoing({ conversationId, id, text: body, sentAt: this.now() });
    await this.deliver(conversationId, id, body);
  }

  private async assertCanSend(conversationId: string): Promise<void> {
    const target = conversationTarget(conversationId);
    if ('groupId' in target && !(await this.history.getGroup(target.groupId))?.active) throw new NotGroupMemberError();
  }

  /** Tenta reenviar uma mensagem que falhou (texto ou mídia). */
  async retry(id: string): Promise<void> {
    const m = await this.history.getOutgoing(id);
    if (!m) return;
    await this.history.setOutgoingStatus(id, 'sending');
    if (m.kind === 'text') await this.deliver(m.conversationId, id, m.text ?? '');
    else await this.deliverMedia(m.conversationId, id);
  }

  // ---- fotos, vídeos e áudios ----

  /**
   * Envia uma foto, vídeo ou áudio. O arquivo é cifrado e guardado no
   * aparelho antes de qualquer envio, então a mensagem aparece na hora e pode
   * ser reenviada se a rede falhar.
   */
  async sendMedia(conversationId: string, input: MediaInput): Promise<void> {
    if (input.bytes.length > MEDIA_LIMITS[input.kind]) throw new MediaTooLargeError(input.kind, MEDIA_LIMITS[input.kind]);
    await this.assertCanSend(conversationId);
    const me = this.state.me!.id;
    const id = newMessageId();
    const enc = encryptAttachment(input.bytes);
    await this.deps.media.save(mediaKey(me, id), enc.ciphertext);
    const attachment: StoredAttachment = {
      id: '', // preenchido depois do envio ao servidor
      key: toBase64(enc.key),
      digest: toBase64(enc.digest),
      mime: input.mime,
      size: input.bytes.length,
      ...(input.width !== undefined && { width: input.width }),
      ...(input.height !== undefined && { height: input.height }),
      ...(input.durationMs !== undefined && { durationMs: input.durationMs }),
      ...(input.thumbnail && { thumbnail: input.thumbnail }),
    };
    const caption = input.caption?.trim() || null;
    await this.history.saveOutgoing({ conversationId, id, kind: input.kind, text: caption, sentAt: this.now(), attachment });
    await this.deliverMedia(conversationId, id);
  }

  private async deliverMedia(conversationId: string, id: string): Promise<void> {
    const me = this.state.me!.id;
    try {
      const m = await this.history.getMessage(me, id);
      if (!m?.attachment) throw new Error('mensagem sem anexo');
      let pointer = m.attachment;
      if (!pointer.id) {
        // Ainda não foi para o servidor: envia a cópia cifrada guardada.
        const ciphertext = await this.deps.media.read(mediaKey(me, id));
        if (!ciphertext) throw new Error('arquivo não encontrado no aparelho');
        const { id: _empty, key, digest, ...meta } = pointer;
        void _empty;
        const uploaded = await this.client.uploadAttachment(
          { ciphertext, key: fromBase64(key), digest: fromBase64(digest) },
          meta,
        );
        pointer = { ...pointer, id: uploaded.id };
        await this.history.setMedia(me, id, { attachment: pointer });
      }
      await this.client.sendAttachment(conversationTarget(conversationId), m.kind as MediaKind, pointer, {
        id,
        caption: m.text ?? undefined,
      });
      await this.history.setOutgoingStatus(id, 'sent');
    } catch {
      await this.history.setOutgoingStatus(id, 'failed');
    }
  }

  // ---- limpeza de mídia do aparelho ----

  /**
   * Apaga do aparelho a mídia que atende ao filtro. As mensagens continuam na
   * conversa e a mídia pode ser baixada de novo enquanto o servidor ainda tiver
   * o arquivo. Mídia ainda não enviada é preservada.
   */
  async clearMedia(filter: MediaFilter = {}): Promise<CleanupResult> {
    const result: CleanupResult = { count: 0, bytes: 0, skipped: 0 };
    for (const it of await this.history.listStoredMedia(filter)) {
      if (it.unsent) {
        result.skipped++;
        continue;
      }
      await this.deps.media.delete(mediaKey(it.senderId, it.id));
      await this.history.setMedia(it.senderId, it.id, { mediaState: 'cleared' });
      result.count++;
      result.bytes += it.bytes;
    }
    return result;
  }

  /** Apaga do aparelho a mídia de uma mensagem. Devolve false se ela ainda não foi enviada. */
  async clearMediaItem(m: Pick<Message, 'senderId' | 'id'>): Promise<boolean> {
    const msg = await this.history.getMessage(m.senderId, m.id);
    if (!msg?.attachment || msg.mediaState !== 'ready') return true;
    if (!msg.attachment.id) return false;
    await this.deps.media.delete(mediaKey(m.senderId, m.id));
    await this.history.setMedia(m.senderId, m.id, { mediaState: 'cleared' });
    return true;
  }

  mediaUsage() {
    return this.history.mediaUsage();
  }

  /** Liga (N dias) ou desliga (0) a limpeza automática e já a executa. */
  async setAutoCleanup(days: number): Promise<CleanupResult | null> {
    await this.kv.set(AUTO_CLEANUP_KEY, String(days));
    this.set({ autoCleanupDays: days });
    return this.runAutoCleanup();
  }

  private async runAutoCleanup(): Promise<CleanupResult | null> {
    const days = Number((await this.kv.get(AUTO_CLEANUP_KEY)) ?? 0);
    if (days !== this.state.autoCleanupDays) this.set({ autoCleanupDays: days });
    if (!days) return null;
    return this.clearMedia({ olderThan: this.now() - days * DAY_MS });
  }

  /** Baixa (cifrado) o anexo de uma mensagem recebida e o guarda no aparelho. */
  async downloadMedia(senderId: string, id: string): Promise<void> {
    const m = await this.history.getMessage(senderId, id);
    if (!m?.attachment || m.mediaState === 'ready' || m.mediaState === 'downloading') return;
    await this.history.setMedia(senderId, id, { mediaState: 'downloading' });
    try {
      const ciphertext = await this.client.downloadEncryptedAttachment(m.attachment);
      await this.deps.media.save(mediaKey(senderId, id), ciphertext);
      await this.history.setMedia(senderId, id, { mediaState: 'ready' });
    } catch (err) {
      await this.history.setMedia(senderId, id, {
        mediaState: err instanceof AttachmentExpiredError ? 'expired' : 'error',
      });
    }
  }

  /** Decifra o anexo guardado no aparelho (baixando antes, se preciso). */
  async readMedia(m: Pick<Message, 'senderId' | 'id'>): Promise<Uint8Array> {
    let msg = await this.history.getMessage(m.senderId, m.id);
    if (!msg?.attachment) throw new Error('mensagem sem anexo');
    if (msg.mediaState !== 'ready') {
      await this.downloadMedia(m.senderId, m.id);
      msg = await this.history.getMessage(m.senderId, m.id);
      if (msg?.mediaState === 'expired') throw new AttachmentExpiredError();
      if (msg?.mediaState !== 'ready') throw new Error('não foi possível baixar o arquivo');
    }
    const ciphertext = await this.deps.media.read(mediaKey(m.senderId, m.id));
    if (!ciphertext) throw new Error('arquivo não encontrado no aparelho');
    return decryptAttachment(ciphertext, fromBase64(msg!.attachment!.key), fromBase64(msg!.attachment!.digest));
  }

  /**
   * Prepara um arquivo temporário decifrado para o player de vídeo ou áudio.
   * Chame releaseMediaFile(uri) ao sair da tela.
   */
  async openMediaFile(m: Pick<Message, 'senderId' | 'id'> & { attachment?: StoredAttachment }): Promise<string> {
    const bytes = await this.readMedia(m);
    return this.deps.media.writeTemp(bytes, extensionFor(m.attachment?.mime ?? ''));
  }

  releaseMediaFile(uri: string): Promise<void> {
    return this.deps.media.deleteTemp(uri);
  }

  private async deliver(conversationId: string, id: string, text: string): Promise<void> {
    try {
      await this.client.sendText(conversationTarget(conversationId), text, { id });
      await this.history.setOutgoingStatus(id, 'sent');
    } catch {
      await this.history.setOutgoingStatus(id, 'failed');
    }
  }

  // ---- grupos ----

  /** Procura alguém pelo @nome (para iniciar conversa ou incluir num grupo). */
  async findUser(username: string): Promise<Contact> {
    const user = await this.client.findByUsername(username.trim().replace(/^@/, ''));
    if (user.id === this.state.me?.id) throw new Error('Esse é você 🙂');
    const contact = toContact(user);
    await this.history.upsertContact(contact);
    return contact;
  }

  /** Cria o grupo (você vira administrador) e devolve o ID da conversa. */
  async createGroup(name: string, memberIds: string[]): Promise<string> {
    const g = await this.client.createGroup(name.trim(), memberIds);
    await this.serialGroups(() => this.applyGroup(g));
    return groupConversationId(g.id);
  }

  async renameGroup(groupId: string, name: string): Promise<void> {
    const g = await this.client.renameGroup(groupId, name.trim());
    await this.serialGroups(() => this.applyGroup(g));
  }

  async addGroupMembers(groupId: string, userIds: string[]): Promise<void> {
    const g = await this.client.addGroupMembers(groupId, userIds);
    await this.serialGroups(() => this.applyGroup(g));
  }

  async removeGroupMember(groupId: string, userId: string): Promise<void> {
    await this.client.removeGroupMember(groupId, userId);
    await this.refreshGroup(groupId);
  }

  async setGroupAdmin(groupId: string, userId: string, admin: boolean): Promise<void> {
    const g = await this.client.setGroupRole(groupId, userId, admin ? 'admin' : 'member');
    await this.serialGroups(() => this.applyGroup(g));
  }

  /** Sai do grupo. O histórico continua no aparelho. */
  async leaveGroup(groupId: string): Promise<void> {
    await this.client.leaveGroup(groupId);
    await this.serialGroups(() => this.history.deactivateGroup(groupId, this.now(), 'left'));
  }

  /** Busca o estado atual de um grupo no servidor e registra o que mudou. */
  refreshGroup(groupId: string): Promise<void> {
    return this.serialGroups(async () => {
      const g = await this.client.getGroup(groupId);
      if (g) await this.applyGroup(g);
      else await this.history.deactivateGroup(groupId, this.now(), 'removed');
    });
  }

  /** Confere todos os grupos (ao conectar). */
  syncGroups(): Promise<void> {
    return this.serialGroups(async () => {
      const groups = await this.client.listGroups();
      for (const g of groups) await this.applyGroup(g);
      const current = new Set(groups.map((g) => g.id));
      for (const id of await this.history.activeGroupIds()) {
        if (!current.has(id)) await this.history.deactivateGroup(id, this.now(), 'removed');
      }
    });
  }

  private serialGroups<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.groupQueue.then(fn, fn);
    this.groupQueue = run.catch(() => undefined);
    return run;
  }

  private async applyGroup(g: Group): Promise<void> {
    // Nomes dos membros para a lista e para os avisos ("Maria entrou no grupo").
    for (const m of g.members) {
      if (m.user_id === this.state.me?.id || (await this.history.getContact(m.user_id))) continue;
      try {
        await this.history.upsertContact(toContact(await this.client.api.getUser(m.user_id)));
      } catch {
        // Sem rede ou conta apagada: aparece como "Contato".
      }
    }
    await this.history.saveGroup(g, this.now());
  }

  private async onMessage(m: ReceivedMessage): Promise<void> {
    if (m.groupId) {
      // Grupo desconhecido (ou remetente que não estava na lista): atualiza antes.
      const g = await this.history.getGroup(m.groupId);
      if (!g?.active || !g.members.some((x) => x.userId === m.from)) {
        await this.refreshGroup(m.groupId).catch(() => undefined);
      }
    }
    if (!(await this.history.getContact(m.from))) {
      try {
        await this.history.upsertContact(toContact(await this.client.api.getUser(m.from)));
      } catch {
        // Sem rede: o nome aparece depois.
      }
    }
    const sentAt = Math.min(m.sentAt, this.now() + MAX_CLOCK_SKEW_MS);
    const conversationId = m.groupId ? groupConversationId(m.groupId) : directConversationId(m.from);
    const isNew = await this.history.saveIncoming(
      { from: m.from, id: m.id, kind: m.kind, text: m.text, sentAt, attachment: m.attachment, groupId: m.groupId },
      { read: this.activeConversation === conversationId },
    );
    // Fotos e áudios pequenos chegam já baixados; vídeos esperam um toque.
    if (isNew && m.attachment && m.kind !== 'video' && m.attachment.size <= AUTO_DOWNLOAD_BYTES) {
      void this.downloadMedia(m.from, m.id);
    }
  }

  // ---- número de segurança ----

  /** Número de segurança da conversa com um contato (undefined se nunca conversaram). */
  safetyNumber(peerId: string) {
    return this.client.safetyNumber(peerId);
  }

  /** Se o contato foi verificado, e se a chave dele continua a mesma desde então. */
  async verificationState(peerId: string): Promise<VerificationState> {
    const verified = await this.kv.get(VERIFIED_KEY + peerId);
    if (!verified) return 'unverified';
    const current = await this.client.identityKey(peerId);
    return current && toBase64(current) === verified ? 'verified' : 'changed';
  }

  /**
   * Marca (ou desmarca) o contato como verificado. A marca vale para a chave
   * atual: se ela mudar, o estado passa a 'changed'.
   */
  async setVerified(peerId: string, verified: boolean): Promise<void> {
    if (!verified) {
      await this.kv.delete(VERIFIED_KEY + peerId);
    } else {
      const key = await this.client.identityKey(peerId);
      if (!key) throw new Error('Troque ao menos uma mensagem com a pessoa antes de verificar');
      await this.kv.set(VERIFIED_KEY + peerId, toBase64(key));
    }
    this.set({ verificationVersion: this.state.verificationVersion + 1 });
  }

  /**
   * Confere o QR code lido do celular da outra pessoa. Se o número bater, o
   * contato fica verificado.
   */
  async verifyScannedCode(peerId: string, data: string): Promise<'match' | 'mismatch' | 'invalid'> {
    const scanned = parseSafetyQr(data);
    if (!scanned) return 'invalid';
    const mine = await this.client.safetyNumber(peerId);
    if (!mine || mine !== scanned) return 'mismatch';
    await this.setVerified(peerId, true);
    return 'match';
  }
}

function toContact(u: User): Contact {
  return { id: u.id, username: u.username, displayName: u.display_name };
}

function isNetworkError(err: unknown): boolean {
  return err instanceof TypeError || (err instanceof Error && /network|fetch|sem rede/i.test(err.message));
}
