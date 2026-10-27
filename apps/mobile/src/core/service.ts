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
  type FetchLike,
  KeyValueStorage,
  type ReceivedMessage,
  type User,
  newMessageId,
} from '@bate-papo/client';

import { type Contact, History, type Message, type StoredAttachment, directConversationId } from './history';
import { type MediaStore, extensionFor, mediaKey } from './media';
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
}

export interface ServiceDeps {
  db: Sql;
  /** Onde ficam os arquivos de mídia (cifrados). */
  media: MediaStore;
  serverUrl: string;
  fetch?: FetchLike;
  /** Relógio (substituível nos testes). */
  now?: () => number;
}

/** Limites de tamanho por tipo, antes de cifrar (o servidor aceita até 64 MiB). */
export const MEDIA_LIMITS: Record<MediaKind, number> = {
  image: 25 * 1024 * 1024,
  video: 60 * 1024 * 1024,
  voice: 16 * 1024 * 1024,
};
/** Fotos e áudios até este tamanho são baixados assim que chegam; vídeos, só com um toque. */
const AUTO_DOWNLOAD_BYTES = 8 * 1024 * 1024;

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
};

export class AppService {
  readonly history: History;
  private client!: BatePapoClient;
  private storage!: KeyValueStorage;
  private kv!: SqlKV;
  private state: AppState = INITIAL;
  private readonly listeners = new Set<() => void>();
  private activeConversation: string | null = null;
  private unsubscribers: (() => void)[] = [];
  private readonly now: () => number;

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
      this.client.on('connection', (c) => this.set({ online: c === 'connected' })),
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
  }

  private async updatePhase(pinEnabled: boolean): Promise<void> {
    const me = this.state.me;
    if (!me?.username) return this.set({ phase: 'needs-profile' });
    if (!pinEnabled) return this.set({ phase: 'needs-pin' });
    const checked = Number((await this.kv.get(PIN_CHECKED_KEY)) ?? 0);
    this.set({ phase: 'ready', pinReminderDue: this.now() - checked > PIN_REMINDER_MS });
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
    await this.storage.clear();
    await this.history.clear();
    await this.deps.media.clear();
    this.newClient();
    this.set({ ...INITIAL, phase: 'signed-out', signedOutReason: reason });
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
    await this.history.saveOutgoing({ to: peerId, id, text: body, sentAt: this.now() });
    await this.deliver(peerId, id, body);
  }

  /** Tenta reenviar uma mensagem que falhou (texto ou mídia). */
  async retry(id: string): Promise<void> {
    const m = await this.history.getOutgoing(id);
    if (!m) return;
    await this.history.setOutgoingStatus(id, 'sending');
    if (m.kind === 'text') await this.deliver(m.to, id, m.text ?? '');
    else await this.deliverMedia(m.to, id);
  }

  // ---- fotos, vídeos e áudios ----

  /**
   * Envia uma foto, vídeo ou áudio. O arquivo é cifrado e guardado no
   * aparelho antes de qualquer envio, então a mensagem aparece na hora e pode
   * ser reenviada se a rede falhar.
   */
  async sendMedia(peerId: string, input: MediaInput): Promise<void> {
    if (input.bytes.length > MEDIA_LIMITS[input.kind]) throw new MediaTooLargeError(input.kind, MEDIA_LIMITS[input.kind]);
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
    await this.history.saveOutgoing({ to: peerId, id, kind: input.kind, text: caption, sentAt: this.now(), attachment });
    await this.deliverMedia(peerId, id);
  }

  private async deliverMedia(peerId: string, id: string): Promise<void> {
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
      await this.client.sendAttachment({ userId: peerId }, m.kind as MediaKind, pointer, {
        id,
        caption: m.text ?? undefined,
      });
      await this.history.setOutgoingStatus(id, 'sent');
    } catch {
      await this.history.setOutgoingStatus(id, 'failed');
    }
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

  private async deliver(peerId: string, id: string, text: string): Promise<void> {
    try {
      await this.client.sendText({ userId: peerId }, text, { id });
      await this.history.setOutgoingStatus(id, 'sent');
    } catch {
      await this.history.setOutgoingStatus(id, 'failed');
    }
  }

  private async onMessage(m: ReceivedMessage): Promise<void> {
    // Grupos ainda não aparecem no app (próxima fatia).
    if (m.groupId) return;
    if (!(await this.history.getContact(m.from))) {
      try {
        await this.history.upsertContact(toContact(await this.client.api.getUser(m.from)));
      } catch {
        // Sem rede: o nome aparece depois.
      }
    }
    const sentAt = Math.min(m.sentAt, this.now() + MAX_CLOCK_SKEW_MS);
    const isNew = await this.history.saveIncoming(
      { from: m.from, id: m.id, kind: m.kind, text: m.text, sentAt, attachment: m.attachment },
      { read: this.activeConversation === directConversationId(m.from) },
    );
    // Fotos e áudios pequenos chegam já baixados; vídeos esperam um toque.
    if (isNew && m.attachment && m.kind !== 'video' && m.attachment.size <= AUTO_DOWNLOAD_BYTES) {
      void this.downloadMedia(m.from, m.id);
    }
  }

  /** Número de segurança da conversa com um contato. */
  safetyNumber(peerId: string) {
    return this.client.safetyNumber(peerId);
  }
}

function toContact(u: User): Contact {
  return { id: u.id, username: u.username, displayName: u.display_name };
}
