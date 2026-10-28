/// <reference types="node" />
// Número de segurança e verificação por QR code, contra o servidor Go real.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RegistrationLockedError } from '@bate-papo/client';

import { directConversationId } from '../src/core/history';
import { MemoryMediaStore } from '../src/core/media';
import { parseSafetyQr, safetyNumberBlocks, safetyQrPayload } from '../src/core/safety';
import { AppService } from '../src/core/service';
import { PIN, dbUrl, signUp, startServer, until } from './helpers';
import { nodeSql } from './node-sql';

let baseUrl = '';
let stop = () => {};

describe('código QR do número de segurança', () => {
  it('aceita só códigos do Bate-Papo com 60 dígitos', () => {
    const n = '0123456789'.repeat(6);
    expect(parseSafetyQr(safetyQrPayload(n))).toBe(n);
    expect(parseSafetyQr(n)).toBeNull();
    expect(parseSafetyQr(safetyQrPayload(n.slice(1)))).toBeNull();
    expect(parseSafetyQr(safetyQrPayload(n.slice(1) + 'x'))).toBeNull();
    expect(safetyNumberBlocks(n)).toHaveLength(12);
    expect(safetyNumberBlocks(n)[0]).toBe('01234');
  });
});

describe.skipIf(!dbUrl)('verificação de contatos', () => {
  beforeAll(async () => {
    ({ baseUrl, stop } = await startServer());
  });
  afterAll(() => stop());

  it('verifica pelo QR e avisa quando a chave muda depois', async () => {
    const ana = await signUp(baseUrl, 'anaverif');
    const beto = await signUp(baseUrl, 'betoverif');
    await until(() => (ana.app.getState().online && beto.app.getState().online ? true : undefined));

    // Sem conversa ainda, não há número para conferir.
    expect(await ana.app.safetyNumber(beto.id)).toBeUndefined();
    await expect(ana.app.setVerified(beto.id, true)).rejects.toThrow(/mensagem/);

    await ana.app.startConversation(beto.username);
    await ana.app.sendText(directConversationId(beto.id), 'oi');
    await until(async () => ((await beto.app.history.listMessages(directConversationId(ana.id))).length ? true : undefined));

    // Os dois celulares mostram o mesmo número.
    const n = (await ana.app.safetyNumber(beto.id))!;
    expect(n).toMatch(/^\d{60}$/);
    expect(await beto.app.safetyNumber(ana.id)).toBe(n);
    expect(await ana.app.verificationState(beto.id)).toBe('unverified');

    // Ana lê o QR do celular do Beto.
    expect(await ana.app.verifyScannedCode(beto.id, 'https://golpe.example')).toBe('invalid');
    expect(await ana.app.verifyScannedCode(beto.id, safetyQrPayload('1'.repeat(60)))).toBe('mismatch');
    expect(await ana.app.verificationState(beto.id)).toBe('unverified');
    expect(await ana.app.verifyScannedCode(beto.id, safetyQrPayload(n))).toBe('match');
    expect(await ana.app.verificationState(beto.id)).toBe('verified');

    // Beto reinstala o app (outra chave) e escreve de novo: a verificação cai.
    ana.app.pause();
    beto.app.pause();
    const beto2 = new AppService({ db: nodeSql(), media: new MemoryMediaStore(), serverUrl: baseUrl });
    await beto2.init();
    const { dev_code } = await beto2.requestCode(beto.phone);
    const locked = await beto2.verifyCode(beto.phone, dev_code!).catch((e: unknown) => e);
    expect(locked).toBeInstanceOf(RegistrationLockedError);
    await beto2.unlock((locked as RegistrationLockedError).lockToken, { pin: PIN });
    ana.app.resume();
    await beto2.sendText(directConversationId(ana.id), 'troquei de celular');
    await until(async () =>
      (await ana.app.history.listMessages(directConversationId(beto.id))).some((m) => m.text === 'troquei de celular')
        ? true
        : undefined,
    );
    expect(ana.app.getState().identityAlert?.userId).toBe(beto.id);
    expect(await ana.app.verificationState(beto.id)).toBe('changed');
    const n2 = await ana.app.safetyNumber(beto.id);
    expect(n2).not.toBe(n);
    expect(await beto2.safetyNumber(ana.id)).toBe(n2);

    // Conferindo de novo, volta a verificado; desmarcar também funciona.
    expect(await ana.app.verifyScannedCode(beto.id, safetyQrPayload(n2!))).toBe('match');
    expect(await ana.app.verificationState(beto.id)).toBe('verified');
    await ana.app.setVerified(beto.id, false);
    expect(await ana.app.verificationState(beto.id)).toBe('unverified');

    ana.app.pause();
    beto2.pause();
  });
});
