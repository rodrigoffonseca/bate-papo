/// <reference types="node" />
// Testa o serviço do app (cadastro, perfil, conversa) contra o servidor Go
// real, com o banco local em node:sqlite.
//
//   BATEPAPO_TEST_DATABASE_URL=postgres://... npm test -w @bate-papo/mobile

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { directConversationId } from '../src/core/history';
import { AppService } from '../src/core/service';
import { nodeSql } from './node-sql';

const dbUrl = process.env.BATEPAPO_TEST_DATABASE_URL;
const serverDir = fileURLToPath(new URL('../../../server', import.meta.url));

let server: ChildProcess | undefined;
let baseUrl = '';
let tmp = '';
let seq = Date.now() % 10_000_000;

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function signUp(name: string) {
  const app = new AppService({ db: nodeSql(), serverUrl: baseUrl });
  await app.init();
  expect(app.getState().phase).toBe('signed-out');
  const phone = `(11) 9${String(++seq).padStart(8, '0')}`;
  const { dev_code } = await app.requestCode(phone);
  await app.verifyCode(phone, dev_code!);
  expect(app.getState().phase).toBe('needs-profile');
  const username = `${name}${seq}`;
  await app.saveProfile({ username, displayName: name[0]!.toUpperCase() + name.slice(1) });
  expect(app.getState().phase).toBe('ready');
  return { app, username, phone };
}

describe.skipIf(!dbUrl)('serviço do app com o servidor', () => {
  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'batepapo-app-'));
    const bin = join(tmp, 'batepapo-server');
    execFileSync('go', ['build', '-o', bin, './cmd/batepapo-server'], { cwd: serverDir, stdio: 'inherit' });
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(bin, [], {
      env: {
        ...process.env,
        BATEPAPO_ENV: 'development',
        BATEPAPO_LISTEN_ADDR: `127.0.0.1:${port}`,
        BATEPAPO_DATABASE_URL: dbUrl,
        BATEPAPO_DEV_EXPOSE_OTP: 'true',
        BATEPAPO_BLOB_DIR: join(tmp, 'blobs'),
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    await until(async () => ((await fetch(`${baseUrl}/healthz`).catch(() => null))?.ok ? true : undefined), 20_000);
  });

  afterAll(() => {
    server?.kill();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('cadastro, nova conversa por @nome e troca de mensagens com histórico', async () => {
    const ana = await signUp('ana');
    const beto = await signUp('beto');
    await until(() => (ana.app.getState().online && beto.app.getState().online ? true : undefined));

    const conv = await ana.app.startConversation('@' + beto.username);
    expect(conv).toBe(directConversationId(beto.app.getState().me!.id));
    await expect(ana.app.startConversation(ana.username)).rejects.toThrow(/você/);

    await ana.app.sendText(beto.app.getState().me!.id, '  Oi, Beto!  ');
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
    await beto.app.sendText(anaId, 'Oi, Ana!');
    await until(async () => ((await ana.app.history.listMessages(conv)).length === 2 ? true : undefined));
    ana.app.setActiveConversation(conv);
    await ana.app.sendText(beto.app.getState().me!.id, 'Tudo bem?');
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
      serverUrl: baseUrl,
      fetch: (url, init) =>
        offline ? Promise.reject(new Error('sem rede')) : globalThis.fetch(url, init as RequestInit),
    });
    await app.init();
    const phone = `(31) 9${String(++seq).padStart(8, '0')}`;
    await app.verifyCode(phone, (await app.requestCode(phone)).dev_code!);
    await app.saveProfile({ username: `duda${seq}`, displayName: 'Duda' });
    const beto = await signUp('beto');
    const betoId = beto.app.getState().me!.id;
    const conv = await app.startConversation(beto.username);

    offline = true;
    await app.sendText(betoId, 'vai chegar depois');
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
    const app = new AppService({ db, serverUrl: baseUrl });
    await app.init();
    const phone = `(21) 9${String(++seq).padStart(8, '0')}`;
    await app.verifyCode(phone, (await app.requestCode(phone)).dev_code!);
    await app.saveProfile({ username: `caio${seq}`, displayName: 'Caio' });
    app.pause();

    const reopened = new AppService({ db, serverUrl: baseUrl });
    await reopened.init();
    expect(reopened.getState()).toMatchObject({ phase: 'ready', me: { username: `caio${seq}` } });

    await reopened.logout();
    expect(reopened.getState().phase).toBe('signed-out');
    const again = new AppService({ db, serverUrl: baseUrl });
    await again.init();
    expect(again.getState().phase).toBe('signed-out');
  });
});
