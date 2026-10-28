/// <reference types="node" />
// Fotos, vídeos e áudios pelo serviço do app, contra o servidor Go real.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BatePapoClient, KeyValueStorage } from '@bate-papo/client';

import { directConversationId } from '../src/core/history';
import { MemoryMediaStore, mediaKey } from '../src/core/media';
import { AppService, MEDIA_LIMITS, MediaTooLargeError } from '../src/core/service';
import { PIN } from './helpers';
import { dbUrl, nextPhone, randomSuffix, signUp, startServer, until } from './helpers';
import { nodeSql } from './node-sql';

let baseUrl = '';
let stop = () => {};

const bytes = (n: number, seed: number) => new Uint8Array(n).map((_, i) => (i * seed) % 251);

describe.skipIf(!dbUrl)('mídia no app', () => {
  beforeAll(async () => {
    ({ baseUrl, stop } = await startServer());
  });
  afterAll(() => stop());

  it('foto e áudio chegam já baixados; vídeo só com um toque', async () => {
    const ana = await signUp(baseUrl, 'anamidia');
    const bia = await signUp(baseUrl, 'biamidia');
    await until(() => (bia.app.getState().online ? true : undefined));
    const conv = directConversationId(ana.id);

    const photo = bytes(120_000, 7);
    await ana.app.sendMedia(directConversationId(bia.id), {
      kind: 'image', bytes: photo, mime: 'image/jpeg', width: 1600, height: 1200,
      thumbnail: 'miniatura', caption: 'pôr do sol',
    });
    const voice = bytes(40_000, 13);
    await ana.app.sendMedia(directConversationId(bia.id), { kind: 'voice', bytes: voice, mime: 'audio/mp4', durationMs: 4200 });
    const video = bytes(500_000, 17);
    await ana.app.sendMedia(directConversationId(bia.id), {
      kind: 'video', bytes: video, mime: 'video/mp4', width: 1280, height: 720, durationMs: 9000, thumbnail: 'quadro',
    });

    // Quem enviou vê tudo "enviado" e consegue abrir a própria mídia.
    const sent = await ana.app.history.listMessages(directConversationId(bia.id));
    expect(sent.map((m) => [m.kind, m.status, m.mediaState])).toEqual([
      ['video', 'sent', 'ready'],
      ['voice', 'sent', 'ready'],
      ['image', 'sent', 'ready'],
    ]);
    expect(await ana.app.readMedia(sent[2]!)).toEqual(photo);
    // O que fica guardado no aparelho é a versão cifrada.
    expect(ana.media.files.get(mediaKey(ana.id, sent[2]!.id))).not.toEqual(photo);

    const received = await until(async () => {
      const list = await bia.app.history.listMessages(conv);
      const ready = list.filter((m) => m.mediaState === 'ready').length;
      return list.length === 3 && ready === 2 ? list : undefined;
    });
    const [vid, aud, img] = received;
    expect(img).toMatchObject({ kind: 'image', text: 'pôr do sol', attachment: { width: 1600, thumbnail: 'miniatura' } });
    expect(aud).toMatchObject({ kind: 'voice', mediaState: 'ready', attachment: { durationMs: 4200 } });
    expect(vid).toMatchObject({ kind: 'video', mediaState: 'remote', attachment: { thumbnail: 'quadro' } });
    expect((await bia.app.history.listConversations())[0]!.lastText).toBe('🎬 Vídeo');

    expect(await bia.app.readMedia(img!)).toEqual(photo);
    // Áudio e vídeo viram arquivo temporário para o player, apagado depois.
    const audioUri = await bia.app.openMediaFile(aud!);
    expect(audioUri).toMatch(/\.m4a$/);
    expect(bia.media.temps.get(audioUri)).toEqual(voice);
    await bia.app.releaseMediaFile(audioUri);
    expect(bia.media.temps.size).toBe(0);

    // Vídeo: baixa ao tocar.
    const videoUri = await bia.app.openMediaFile(vid!);
    expect(bia.media.temps.get(videoUri)).toEqual(video);
    expect((await bia.app.history.getMessage(ana.id, vid!.id))!.mediaState).toBe('ready');

    // Sair da conta apaga os arquivos.
    await bia.app.logout();
    expect(bia.media.files.size).toBe(0);
    expect(bia.media.temps.size).toBe(0);
    ana.app.pause();
  });

  it('mídia enviada sem rede fica guardada e é reenviada sem cifrar de novo', async () => {
    let offline = false;
    const media = new MemoryMediaStore();
    const app = new AppService({
      db: nodeSql(),
      media,
      serverUrl: baseUrl,
      fetch: (url, init) => (offline ? Promise.reject(new Error('sem rede')) : globalThis.fetch(url, init as RequestInit)),
    });
    await app.init();
    const phone = nextPhone('51');
    await app.verifyCode(phone, (await app.requestCode(phone)).dev_code!);
    await app.saveProfile({ username: `edu${Date.now() % 1e7}`, displayName: 'Edu' });
    await app.setPin('pin forte 2026');
    await app.recoveryCodeSaved();
    const fe = await signUp(baseUrl, 'femidia');

    offline = true;
    const photo = bytes(80_000, 3);
    await app.sendMedia(directConversationId(fe.id), { kind: 'image', bytes: photo, mime: 'image/png' });
    const [failed] = await app.history.listMessages(directConversationId(fe.id));
    expect(failed).toMatchObject({ status: 'failed', mediaState: 'ready', attachment: { id: '' } });
    const stored = media.files.get(mediaKey(app.getState().me!.id, failed!.id));

    offline = false;
    await app.retry(failed!.id);
    const [ok] = await app.history.listMessages(directConversationId(fe.id));
    expect(ok!.status).toBe('sent');
    expect(ok!.attachment!.id).not.toBe('');
    // A mesma cópia cifrada foi enviada (sem recifrar).
    expect(media.files.get(mediaKey(app.getState().me!.id, failed!.id))).toEqual(stored);

    await fe.app.history.listMessages(directConversationId(app.getState().me!.id));
    const got = await until(async () => {
      const [m] = await fe.app.history.listMessages(directConversationId(app.getState().me!.id));
      return m?.mediaState === 'ready' ? m : undefined;
    });
    expect(await fe.app.readMedia(got)).toEqual(photo);
    app.pause();
    fe.app.pause();
  });

  it('recusa arquivo grande demais e marca anexo que o servidor já apagou', async () => {
    const gil = await signUp(baseUrl, 'gilmidia');
    const hugo = await signUp(baseUrl, 'hugomidia');
    await expect(
      gil.app.sendMedia(directConversationId(hugo.id), { kind: 'voice', bytes: new Uint8Array(MEDIA_LIMITS.voice + 1), mime: 'audio/mp4' }),
    ).rejects.toBeInstanceOf(MediaTooLargeError);

    // Um cliente manda um ponteiro para um arquivo que não existe mais.
    const raw = new BatePapoClient({ serverUrl: baseUrl, storage: new KeyValueStorage() });
    const phone = nextPhone('61');
    await raw.verifyCode(phone, (await raw.requestCode(phone)).dev_code!);
    await raw.sendAttachment({ userId: hugo.id }, 'image', {
      id: '00000000-0000-0000-0000-000000000000', key: 'AAAA', digest: 'AAAA', mime: 'image/jpeg', size: 10,
    });
    const expired = await until(async () => {
      const [m] = await hugo.app.history.listMessages(directConversationId(raw.currentUserId));
      return m?.mediaState === 'expired' ? m : undefined;
    });
    await expect(hugo.app.readMedia(expired)).rejects.toThrow(/não está mais disponível/);
    gil.app.pause();
    hugo.app.pause();
  });

  it('limpeza: uso por tipo e conversa, apagar por filtro, baixar de novo e não perder o que não foi enviado', async () => {
    const ana = await signUp(baseUrl, 'analimpa');
    const bia = await signUp(baseUrl, 'bialimpa');
    const caio = await signUp(baseUrl, 'caiolimpa');

    await bia.app.sendMedia(directConversationId(ana.id), { kind: 'image', bytes: bytes(100_000, 3), mime: 'image/jpeg' });
    await bia.app.sendMedia(directConversationId(ana.id), { kind: 'voice', bytes: bytes(20_000, 5), mime: 'audio/mp4', durationMs: 2000 });
    await caio.app.sendMedia(directConversationId(ana.id), { kind: 'image', bytes: bytes(50_000, 7), mime: 'image/jpeg' });
    const biaConv = directConversationId(bia.id);
    const caioConv = directConversationId(caio.id);
    await until(async () => ((await ana.app.mediaUsage()).byKind.image.count === 2 &&
      (await ana.app.mediaUsage()).byKind.voice.count === 1 ? true : undefined));

    const usage = await ana.app.mediaUsage();
    expect(usage.totalBytes).toBe(170_000);
    expect(usage.byKind).toMatchObject({ image: { count: 2, bytes: 150_000 }, voice: { count: 1, bytes: 20_000 } });
    expect(usage.byConversation.map((c) => [c.title, c.count, c.bytes])).toEqual([
      ['Bialimpa', 2, 120_000],
      ['Caiolimpa', 1, 50_000],
    ]);

    // Apaga só as fotos da conversa com a Bia.
    const r = await ana.app.clearMedia({ conversationId: biaConv, kinds: ['image'] });
    expect(r).toEqual({ count: 1, bytes: 100_000, skipped: 0 });
    const [voiceMsg, photoMsg] = await ana.app.history.listMessages(biaConv);
    expect(photoMsg).toMatchObject({ kind: 'image', mediaState: 'cleared' });
    expect(voiceMsg).toMatchObject({ kind: 'voice', mediaState: 'ready' });
    expect(ana.media.files.has(mediaKey(bia.id, photoMsg!.id))).toBe(false);
    expect((await ana.app.mediaUsage()).totalBytes).toBe(70_000);

    // Enquanto o servidor tiver o arquivo, dá para ver de novo.
    expect(await ana.app.readMedia(photoMsg!)).toEqual(bytes(100_000, 3));
    expect((await ana.app.history.getMessage(bia.id, photoMsg!.id))!.mediaState).toBe('ready');

    // Item individual.
    const [caioPhoto] = await ana.app.history.listMessages(caioConv);
    expect(await ana.app.clearMediaItem(caioPhoto!)).toBe(true);
    expect((await ana.app.history.getMessage(caio.id, caioPhoto!.id))!.mediaState).toBe('cleared');

    // Mídia que ainda não foi para o servidor nunca é apagada.
    let offline = false;
    const dani = new AppService({
      db: nodeSql(),
      media: new MemoryMediaStore(),
      serverUrl: baseUrl,
      fetch: (url, init) => (offline ? Promise.reject(new Error('sem rede')) : globalThis.fetch(url, init as RequestInit)),
    });
    await dani.init();
    const phone = nextPhone('71');
    await dani.verifyCode(phone, (await dani.requestCode(phone)).dev_code!);
    await dani.saveProfile({ username: `dani${randomSuffix()}`, displayName: 'Dani' });
    await dani.setPin(PIN);
    await dani.recoveryCodeSaved();
    offline = true;
    await dani.sendMedia(directConversationId(ana.id), { kind: 'image', bytes: bytes(10_000, 9), mime: 'image/jpeg' });
    const [unsent] = await dani.history.listMessages(directConversationId(ana.id));
    expect(await dani.clearMedia()).toEqual({ count: 0, bytes: 0, skipped: 1 });
    expect(await dani.clearMediaItem(unsent!)).toBe(false);
    expect((await dani.history.getMessage(unsent!.senderId, unsent!.id))!.mediaState).toBe('ready');

    for (const u of [ana, bia, caio]) u.app.pause();
    dani.pause();
  });

  it('limpeza automática apaga a mídia antiga ao abrir o app', async () => {
    let now = Date.now();
    const db = nodeSql();
    const media = new MemoryMediaStore();
    const eva = new AppService({ db, media, serverUrl: baseUrl, now: () => now });
    await eva.init();
    const phone = nextPhone('81');
    await eva.verifyCode(phone, (await eva.requestCode(phone)).dev_code!);
    await eva.saveProfile({ username: `eva${randomSuffix()}`, displayName: 'Eva' });
    await eva.setPin(PIN);
    await eva.recoveryCodeSaved();
    const fabio = await signUp(baseUrl, 'fabiolimpa');

    await eva.sendMedia(directConversationId(fabio.id), { kind: 'image', bytes: bytes(30_000, 2), mime: 'image/jpeg' });
    now += 40 * 24 * 60 * 60 * 1000;
    await eva.sendMedia(directConversationId(fabio.id), { kind: 'image', bytes: bytes(30_000, 4), mime: 'image/jpeg' });
    expect((await eva.mediaUsage()).byKind.image.count).toBe(2);

    // Ligar a limpeza de 30 dias já apaga a foto de 40 dias atrás.
    expect(await eva.setAutoCleanup(30)).toEqual({ count: 1, bytes: 30_000, skipped: 0 });
    expect(eva.getState().autoCleanupDays).toBe(30);
    eva.pause();

    // A configuração vale nas próximas aberturas do app.
    now += 31 * 24 * 60 * 60 * 1000;
    const reopened = new AppService({ db, media, serverUrl: baseUrl, now: () => now });
    await reopened.init();
    expect(reopened.getState().autoCleanupDays).toBe(30);
    expect((await reopened.mediaUsage()).totalBytes).toBe(0);
    expect(media.files.size).toBe(0);

    expect(await reopened.setAutoCleanup(0)).toBeNull();
    reopened.pause();
    fabio.app.pause();
  });
});
