/// <reference types="node" />
// Testa o serviço do app (cadastro, perfil, conversa) contra o servidor Go
// real, com o banco local em node:sqlite.
//
//   BATEPAPO_TEST_DATABASE_URL=postgres://... npm test -w @bate-papo/mobile

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RegistrationLockedError } from '@bate-papo/client';

import { directConversationId } from '../src/core/history';
import { MemoryMediaStore } from '../src/core/media';
import { AppService, PIN_REMINDER_MS } from '../src/core/service';
import { PIN, dbUrl, nextPhone, startServer, signUp as signUpAt, uniqueSuffix, until } from './helpers';
import { nodeSql } from './node-sql';

let baseUrl = '';
let stop = () => {};
const signUp = (name: string) => signUpAt(baseUrl, name);

describe.skipIf(!dbUrl)('serviço do app com o servidor', () => {
  beforeAll(async () => {
    ({ baseUrl, stop } = await startServer());
  });

  afterAll(() => stop());

  it('cadastro, nova conversa por @nome e troca de mensagens com histórico', async () => {
    const ana = await signUp('ana');
    const beto = await signUp('beto');
    await until(() => (ana.app.getState().online && beto.app.getState().online ? true : undefined));

    const conv = await ana.app.startConversation('@' + beto.username);
    expect(conv).toBe(directConversationId(beto.app.getState().me!.id));
    await expect(ana.app.startConversation(ana.username)).rejects.toThrow(/você/);

    await ana.app.sendText(directConversationId(beto.app.getState().me!.id), '  Oi, Beto!  ');
    const [sent] = await ana.app.history.listMessages(conv);
    expect(sent).toMatchObject({ text: 'Oi, Beto!', outgoing: true, status: 'sent' });

    // Beto recebe em tempo real; a conversa aparece com o nome da Ana.
    const anaId = ana.app.getState().me!.id;
    const inbox = await until(async () => {
      const list = await beto.app.history.listConversations();
      return list.length ? list : undefined;
    });
    expect(inbox[0]).toMatchObject({ peerId: anaId, title: 'Ana', lastText: 'Oi, Beto!', unread: 1 });

    // Com a conversa aberta, a resposta da Ana não conta como não lida.
    beto.app.setActiveConversation(directConversationId(anaId));
    await beto.app.sendText(directConversationId(anaId), 'Oi, Ana!');
    await until(async () => ((await ana.app.history.listMessages(conv)).length === 2 ? true : undefined));
    ana.app.setActiveConversation(conv);
    await ana.app.sendText(directConversationId(beto.app.getState().me!.id), 'Tudo bem?');
    await until(async () =>
      (await beto.app.history.listMessages(directConversationId(anaId))).length === 3 ? true : undefined,
    );
    expect((await beto.app.history.listConversations())[0]!.unread).toBe(0);

    expect(await ana.app.safetyNumber(beto.app.getState().me!.id)).toBe(await beto.app.safetyNumber(anaId));

    ana.app.pause();
    beto.app.pause();
  });

  it('mensagem que falha sem rede pode ser reenviada', async () => {
    let offline = false;
    const app = new AppService({
      db: nodeSql(),
      media: new MemoryMediaStore(),
      serverUrl: baseUrl,
      fetch: (url, init) =>
        offline ? Promise.reject(new Error('sem rede')) : globalThis.fetch(url, init as RequestInit),
    });
    await app.init();
    const phone = nextPhone('31');
    await app.verifyCode(phone, (await app.requestCode(phone)).dev_code!);
    await app.saveProfile({ username: `duda${uniqueSuffix()}`, displayName: 'Duda' });
    await app.setPin(PIN);
    await app.recoveryCodeSaved();
    const beto = await signUp('beto');
    const betoId = beto.app.getState().me!.id;
    const conv = await app.startConversation(beto.username);

    offline = true;
    await app.sendText(directConversationId(betoId), 'vai chegar depois');
    expect((await app.history.listMessages(conv))[0]).toMatchObject({ status: 'failed' });

    offline = false;
    await app.retry((await app.history.listMessages(conv))[0]!.id);
    expect((await app.history.listMessages(conv))[0]).toMatchObject({ status: 'sent' });
    await until(async () =>
      (await beto.app.history.listMessages(directConversationId(app.getState().me!.id)))[0]?.text === 'vai chegar depois'
        ? true
        : undefined,
    );
    app.pause();
    beto.app.pause();
  });

  it('restaura a sessão ao reabrir o app e sai limpando os dados', async () => {
    const db = nodeSql();
    const media = new MemoryMediaStore();
    const app = new AppService({ db, media, serverUrl: baseUrl });
    await app.init();
    const phone = nextPhone('21');
    await app.verifyCode(phone, (await app.requestCode(phone)).dev_code!);
    await app.saveProfile({ username: `caio${uniqueSuffix()}`, displayName: 'Caio' });
    // Sem PIN definido, o app não libera as conversas.
    app.pause();
    const halfway = new AppService({ db, media, serverUrl: baseUrl });
    await halfway.init();
    expect(halfway.getState().phase).toBe('needs-pin');
    await halfway.setPin(PIN);
    await halfway.recoveryCodeSaved();
    halfway.pause();

    const reopened = new AppService({ db, media, serverUrl: baseUrl });
    await reopened.init();
    expect(reopened.getState()).toMatchObject({ phase: 'ready', me: { username: `caio${uniqueSuffix()}` } });

    await reopened.logout();
    expect(reopened.getState().phase).toBe('signed-out');
    const again = new AppService({ db, media, serverUrl: baseUrl });
    await again.init();
    expect(again.getState().phase).toBe('signed-out');
  });

  it('SIM swap: outro aparelho com o SMS é barrado pelo PIN e o dono é avisado', async () => {
    const owner = await signUp('eva');
    await until(() => (owner.app.getState().online ? true : undefined));

    const thief = new AppService({ db: nodeSql(), media: new MemoryMediaStore(), serverUrl: baseUrl });
    await thief.init();
    const locked = await thief
      .verifyCode(owner.phone, (await thief.requestCode(owner.phone)).dev_code!)
      .catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(RegistrationLockedError);
    expect(thief.getState().phase).toBe('signed-out');
    await until(() => (owner.app.getState().accountAlerts.length ? true : undefined));
    expect(owner.app.getState().accountAlerts[0]!.kind).toBe('registration_attempt');

    const token = (locked as RegistrationLockedError).lockToken;
    expect(await thief.unlock(token, { pin: 'chute 0000' }).catch((e: unknown) => e)).toMatchObject({
      reason: 'wrong_pin',
      attemptsLeft: 9,
    });
    await until(() => (owner.app.getState().accountAlerts.length === 2 ? true : undefined));
    await owner.app.dismissAccountAlerts();
    expect(owner.app.getState().accountAlerts).toEqual([]);

    // O dono, trocando de celular, entra com o PIN e já fica pronto.
    const newPhone = new AppService({ db: nodeSql(), media: new MemoryMediaStore(), serverUrl: baseUrl });
    await newPhone.init();
    const again = await newPhone
      .verifyCode(owner.phone, (await newPhone.requestCode(owner.phone)).dev_code!)
      .catch((e: unknown) => e);
    await newPhone.unlock((again as RegistrationLockedError).lockToken, { pin: PIN });
    expect(newPhone.getState()).toMatchObject({ phase: 'ready', me: { id: owner.app.getState().me!.id } });

    owner.app.pause();
    newPhone.pause();
  });

  it('código de recuperação libera a conta e exige um novo PIN', async () => {
    const owner = await signUp('fabi');
    owner.app.pause();
    const newPhone = new AppService({ db: nodeSql(), media: new MemoryMediaStore(), serverUrl: baseUrl });
    await newPhone.init();
    const locked = await newPhone
      .verifyCode(owner.phone, (await newPhone.requestCode(owner.phone)).dev_code!)
      .catch((e: unknown) => e);
    await newPhone.unlock((locked as RegistrationLockedError).lockToken, {
      recoveryCode: owner.recoveryCode.toLowerCase(),
    });
    expect(newPhone.getState().phase).toBe('needs-pin');
    await newPhone.setPin('novo pin 2027');
    expect(newPhone.getState().recoveryCode).not.toBe(owner.recoveryCode);
    await newPhone.recoveryCodeSaved();
    expect(newPhone.getState().phase).toBe('ready');
    newPhone.pause();
  });

  it('sessão encerrada por outro aparelho e lembrete periódico do PIN', async () => {
    let now = Date.now();
    const db = nodeSql();
    const media = new MemoryMediaStore();
    const app = new AppService({ db, media, serverUrl: baseUrl, now: () => now });
    await app.init();
    const phone = nextPhone('41');
    await app.verifyCode(phone, (await app.requestCode(phone)).dev_code!);
    await app.saveProfile({ username: `gil${uniqueSuffix()}`, displayName: 'Gil' });
    await app.setPin(PIN);
    await app.recoveryCodeSaved();
    app.pause();

    // Duas semanas depois, o app pede para confirmar o PIN.
    now += PIN_REMINDER_MS + 1000;
    const later = new AppService({ db, media, serverUrl: baseUrl, now: () => now });
    await later.init();
    expect(later.getState()).toMatchObject({ phase: 'ready', pinReminderDue: true });
    expect(await later.confirmPin('errado 123')).toBe(false);
    expect(later.getState().pinReminderDue).toBe(true);
    expect(await later.confirmPin(PIN)).toBe(true);
    expect(later.getState().pinReminderDue).toBe(false);
    later.pause();

    // Outro aparelho assume a conta (com o PIN): este é desconectado.
    const other = new AppService({ db: nodeSql(), media: new MemoryMediaStore(), serverUrl: baseUrl });
    await other.init();
    const locked = await other.verifyCode(phone, (await other.requestCode(phone)).dev_code!).catch((e: unknown) => e);
    await other.unlock((locked as RegistrationLockedError).lockToken, { pin: PIN });
    other.pause();

    const reopened = new AppService({ db, media, serverUrl: baseUrl, now: () => now });
    await reopened.init();
    expect(reopened.getState()).toMatchObject({ phase: 'signed-out', signedOutReason: 'session-ended' });
    expect(await reopened.history.listConversations()).toEqual([]);
  });
});
