/// <reference types="node" />
// Utilitários dos testes: sobe o servidor Go de verdade e cadastra usuários
// pelo serviço do app.

import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect } from 'vitest';

import { MemoryMediaStore } from '../src/core/media';
import { AppService } from '../src/core/service';
import { nodeSql } from './node-sql';

export const dbUrl = process.env.BATEPAPO_TEST_DATABASE_URL;
export const PIN = 'pin forte 2026';
const serverDir = fileURLToPath(new URL('../../../server', import.meta.url));

// Ponto de partida aleatório: os arquivos de teste rodam em paralelo contra o
// mesmo banco e não podem gerar os mesmos números de telefone.
let seq = randomInt(80_000_000);

/** Um número de celular novo a cada chamada. */
export function nextPhone(ddd = '11'): string {
  return `(${ddd}) 9${String(++seq).padStart(8, '0')}`;
}

export function uniqueSuffix(): number {
  return seq;
}

/** Sufixo aleatório para nomes de usuário de teste. */
export function randomSuffix(): number {
  return randomInt(10_000_000);
}

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export async function until<T>(fn: () => Promise<T | undefined> | T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error('tempo esgotado');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Compila e sobe o servidor Go; devolve o endereço e a função para parar. */
export async function startServer(): Promise<{ baseUrl: string; stop: () => void }> {
  const tmp = mkdtempSync(join(tmpdir(), 'batepapo-app-'));
  const bin = join(tmp, 'batepapo-server');
  execFileSync('go', ['build', '-o', bin, './cmd/batepapo-server'], { cwd: serverDir, stdio: 'inherit' });
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const server: ChildProcess = spawn(bin, [], {
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
  return {
    baseUrl,
    stop: () => {
      server.kill();
      rmSync(tmp, { recursive: true, force: true });
    },
  };
}

/** Cadastro completo pelo serviço: código SMS, perfil e PIN. */
export async function signUp(baseUrl: string, name: string, media = new MemoryMediaStore()) {
  const app = new AppService({ db: nodeSql(), media, serverUrl: baseUrl });
  await app.init();
  expect(app.getState().phase).toBe('signed-out');
  const phone = nextPhone();
  const { dev_code } = await app.requestCode(phone);
  await app.verifyCode(phone, dev_code!);
  expect(app.getState().phase).toBe('needs-profile');
  const username = `${name}${seq}`;
  await app.saveProfile({ username, displayName: name[0]!.toUpperCase() + name.slice(1) });
  expect(app.getState().phase).toBe('needs-pin');
  await app.setPin(PIN);
  const recoveryCode = app.getState().recoveryCode!;
  expect(recoveryCode).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){5}$/);
  await app.recoveryCodeSaved();
  expect(app.getState()).toMatchObject({ phase: 'ready', recoveryCode: null, pinReminderDue: false });
  return { app, username, phone, recoveryCode, media, id: app.getState().me!.id };
}
