/// <reference types="node" />
// Notificações push sem conteúdo: o app registra o token e o servidor acorda o
// aparelho quando chega mensagem com o app fechado. Usa UnifiedPush com um
// "distribuidor" local, contra o servidor Go real.

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PushKind } from '@bate-papo/client';

import { directConversationId } from '../src/core/history';
import { MemoryMediaStore } from '../src/core/media';
import type { PushPlatform } from '../src/core/service';
import { dbUrl, signUp, startServer, until } from './helpers';

let baseUrl = '';
let stop = () => {};
let distributor = '';
const received: { path: string; body: string }[] = [];
const http = createServer((req, res) => {
  let body = '';
  req.on('data', (c: Buffer) => (body += c.toString()));
  req.on('end', () => {
    received.push({ path: req.url ?? '', body });
    res.writeHead(201).end();
  });
});

/** Aparelho de mentira: devolve o token pedido, ou null (permissão negada). */
function platform(token: { kind: PushKind; token: string } | null): PushPlatform & { change: (t: { kind: PushKind; token: string }) => void } {
  let listener: ((t: { kind: PushKind; token: string }) => void) | undefined;
  return {
    getToken: async () => token,
    onTokenChange: (fn) => {
      listener = fn;
      return () => (listener = undefined);
    },
    change: (t) => listener?.(t),
  };
}

const pushesTo = (path: string) => received.filter((r) => r.path === path);

describe.skipIf(!dbUrl)('notificações push', () => {
  beforeAll(async () => {
    ({ baseUrl, stop } = await startServer());
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    distributor = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    stop();
    http.close();
  });

  it('acorda o aparelho sem revelar nada da mensagem, e respeita quem desliga', async () => {
    const ana = await signUp(baseUrl, 'anapush');
    const dev = platform({ kind: 'unifiedpush', token: `${distributor}/beto` });
    const beto = await signUp(baseUrl, 'betopush', new MemoryMediaStore(), dev);
    await until(() => (beto.app.getState().notifications === 'on' ? true : undefined));

    // Beto fecha o app; a mensagem da Ana acorda o celular dele.
    beto.app.pause();
    await until(() => (beto.app.getState().online ? undefined : true));
    await ana.app.startConversation(beto.username);
    await ana.app.sendText(directConversationId(beto.id), 'segredo: a senha do wifi é 1234');
    const [wake] = await until(() => (pushesTo('/beto').length ? pushesTo('/beto') : undefined));
    // Nada do conteúdo, do remetente ou da conversa.
    expect(wake!.body).toBe('{"t":"message"}');

    // O sistema trocou o token: o app registra o novo.
    dev.change({ kind: 'unifiedpush', token: `${distributor}/beto-novo` });
    await new Promise((r) => setTimeout(r, 200));

    // Beto abre e fecha o app; a próxima mensagem vai para o token novo.
    beto.app.resume();
    await until(() => (beto.app.getState().online ? true : undefined));
    beto.app.pause();
    await until(() => (beto.app.getState().online ? undefined : true));
    await ana.app.sendText(directConversationId(beto.id), 'de novo');
    await until(() => (pushesTo('/beto-novo').length ? true : undefined));

    // Desligou as notificações: não acorda mais.
    expect(await beto.app.setNotifications(false)).toBe('off');
    beto.app.resume();
    await until(() => (beto.app.getState().online ? true : undefined));
    beto.app.pause();
    await until(() => (beto.app.getState().online ? undefined : true));
    const before = received.length;
    await ana.app.sendText(directConversationId(beto.id), 'sem aviso');
    await new Promise((r) => setTimeout(r, 500));
    expect(received.length).toBe(before);
    expect(await beto.app.setNotifications(true)).toBe('on');

    ana.app.pause();
  });

  it('permissão negada e serviço indisponível no servidor', async () => {
    const caio = await signUp(baseUrl, 'caiopush', new MemoryMediaStore(), platform(null));
    await until(() => (caio.app.getState().notifications === 'denied' ? true : undefined));

    // O servidor de teste não tem FCM configurado.
    const duda = await signUp(baseUrl, 'dudapush', new MemoryMediaStore(), platform({ kind: 'fcm', token: 'tok' }));
    await until(() => (duda.app.getState().notifications === 'unavailable' ? true : undefined));

    // Sem suporte a push no app (ex.: versão sem Firebase).
    const eva = await signUp(baseUrl, 'evapush');
    await until(() => (eva.app.getState().notifications === 'unavailable' ? true : undefined));

    for (const u of [caio, duda, eva]) u.app.pause();
  });
});
