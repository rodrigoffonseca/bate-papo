/// <reference types="node" />
// Grupos no app: criar, conversar, incluir, remover, sair e administradores,
// contra o servidor Go real.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Message, groupConversationId } from '../src/core/history';
import { NotGroupMemberError } from '../src/core/service';
import { dbUrl, signUp, startServer, until } from './helpers';

let baseUrl = '';
let stop = () => {};

type User = Awaited<ReturnType<typeof signUp>>;

/** Espera um aviso (mensagem do sistema) com o texto na conversa. */
function notice(u: User, conv: string, text: string | RegExp) {
  return until(async () => {
    const msgs = await u.app.history.listMessages(conv);
    return msgs.find((m) => m.kind === 'system' && (typeof text === 'string' ? m.text === text : text.test(m.text ?? '')));
  });
}

function messageWith(u: User, conv: string, pred: (m: Message) => boolean) {
  return until(async () => (await u.app.history.listMessages(conv)).find(pred));
}

const online = (...us: User[]) => until(() => (us.every((u) => u.app.getState().online) ? true : undefined));

describe.skipIf(!dbUrl)('grupos no app', () => {
  beforeAll(async () => {
    ({ baseUrl, stop } = await startServer());
  });
  afterAll(() => stop());

  it('cria o grupo, conversa com texto e foto, e todos veem quem entra e quem sai', async () => {
    const ana = await signUp(baseUrl, 'anagrupo');
    const bia = await signUp(baseUrl, 'biagrupo');
    const caio = await signUp(baseUrl, 'caiogrupo');
    const dani = await signUp(baseUrl, 'danigrupo');
    await online(ana, bia, caio, dani);

    // Ana encontra as pessoas pelo @nome e cria o grupo.
    const members = [await ana.app.findUser('@' + bia.username), await ana.app.findUser(caio.username)];
    await expect(ana.app.findUser(ana.username)).rejects.toThrow(/você/);
    const conv = await ana.app.createGroup('  Família  ', members.map((m) => m.id));
    const gid = conv.slice(2);
    expect(conv).toBe(groupConversationId(gid));
    await notice(ana, conv, 'Você criou o grupo “Família”');
    const [c] = await ana.app.history.listConversations();
    expect(c).toMatchObject({ id: conv, kind: 'group', title: 'Família', active: true, unread: 0 });
    const g = await ana.app.history.getGroup(gid);
    expect(g!.members.map((m) => [m.name, m.role])).toEqual([
      ['Você', 'admin'],
      ['Biagrupo', 'member'],
      ['Caiogrupo', 'member'],
    ]);

    // Os membros recebem o aviso em tempo real, sem mensagem nenhuma ainda.
    await notice(bia, conv, 'Você entrou no grupo “Família”');
    await notice(caio, conv, 'Você entrou no grupo “Família”');
    expect((await bia.app.history.getGroup(gid))!.members.find((m) => m.userId === ana.id)!.name).toBe('Anagrupo');

    // Texto e foto chegam a todos, com o nome de quem enviou.
    await ana.app.sendText(conv, 'Oi, família!');
    const [sent] = await ana.app.history.listMessages(conv);
    expect(sent).toMatchObject({ text: 'Oi, família!', outgoing: true, status: 'sent' });
    for (const u of [bia, caio]) {
      const got = await messageWith(u, conv, (m) => m.text === 'Oi, família!');
      expect(got).toMatchObject({ senderId: ana.id, senderName: 'Anagrupo', outgoing: false });
    }
    expect((await bia.app.history.listConversations())[0]).toMatchObject({ id: conv, title: 'Família', unread: 1 });

    const photo = new Uint8Array(50_000).map((_, i) => (i * 7) % 251);
    await caio.app.sendMedia(conv, { kind: 'image', bytes: photo, mime: 'image/jpeg', caption: 'churrasco' });
    for (const u of [ana, bia]) {
      const got = await messageWith(u, conv, (m) => m.kind === 'image' && m.mediaState === 'ready');
      expect(got).toMatchObject({ text: 'churrasco', senderName: 'Caiogrupo' });
      expect(await u.app.readMedia(got)).toEqual(photo);
    }

    // Membros comuns não administram o grupo.
    await expect(bia.app.addGroupMembers(gid, [dani.id])).rejects.toThrow();

    // Ana inclui a Dani e muda o nome: todos veem.
    await ana.app.findUser(dani.username);
    await ana.app.addGroupMembers(gid, [dani.id]);
    await notice(ana, conv, 'Danigrupo entrou no grupo');
    await notice(bia, conv, 'Danigrupo entrou no grupo');
    await notice(dani, conv, 'Você entrou no grupo “Família”');
    // Quem entra não vê as mensagens anteriores (elas não foram cifradas para ela).
    expect((await dani.app.history.listMessages(conv)).filter((m) => m.kind !== 'system')).toEqual([]);

    await ana.app.renameGroup(gid, 'Família Silva');
    await notice(bia, conv, 'O nome do grupo mudou para “Família Silva”');
    expect((await bia.app.history.getConversation(conv))!.title).toBe('Família Silva');

    await ana.app.setGroupAdmin(gid, dani.id, true);
    await notice(dani, conv, 'Agora você é administrador(a) do grupo');
    await notice(bia, conv, 'Danigrupo agora é administrador(a)');

    // Dani (agora admin) remove o Caio: ele não pode mais enviar, e o histórico fica.
    await dani.app.removeGroupMember(gid, caio.id);
    await notice(caio, conv, 'Você não faz mais parte deste grupo');
    expect(await caio.app.history.getConversation(conv)).toMatchObject({ active: false, title: 'Família Silva' });
    await expect(caio.app.sendText(conv, 'ei!')).rejects.toBeInstanceOf(NotGroupMemberError);
    expect(await caio.app.history.listMessages(conv)).toEqual(
      expect.arrayContaining([expect.objectContaining({ text: 'Oi, família!' })]),
    );
    await notice(ana, conv, 'Caiogrupo saiu do grupo');

    // Bia sai por conta própria; a próxima mensagem não vai mais para ela nem para o Caio.
    await bia.app.leaveGroup(gid);
    await notice(bia, conv, 'Você saiu do grupo');
    await notice(ana, conv, 'Biagrupo saiu do grupo');
    await ana.app.sendText(conv, 'só nós duas');
    await messageWith(dani, conv, (m) => m.text === 'só nós duas');
    await new Promise((r) => setTimeout(r, 300));
    for (const u of [bia, caio]) {
      expect((await u.app.history.listMessages(conv)).some((m) => m.text === 'só nós duas')).toBe(false);
    }

    for (const u of [ana, bia, caio, dani]) u.app.pause();
  });

  it('quem estava desconectado vê as mudanças ao reconectar', async () => {
    const ana = await signUp(baseUrl, 'anarecon');
    const eva = await signUp(baseUrl, 'evarecon');
    const fabio = await signUp(baseUrl, 'fabiorecon');
    await online(ana, eva, fabio);
    await ana.app.findUser(eva.username);
    await ana.app.findUser(fabio.username);
    const conv = await ana.app.createGroup('Trabalho', [eva.id]);
    const gid = conv.slice(2);
    await notice(eva, conv, 'Você entrou no grupo “Trabalho”');

    eva.app.pause();
    await until(() => (eva.app.getState().online ? undefined : true));
    await ana.app.addGroupMembers(gid, [fabio.id]);
    await ana.app.renameGroup(gid, 'Trabalho 2026');
    eva.app.resume();
    await notice(eva, conv, 'Fabiorecon entrou no grupo');
    await notice(eva, conv, 'O nome do grupo mudou para “Trabalho 2026”');
    // Cada mudança aparece uma única vez, mesmo com avisos e sincronização juntos.
    await new Promise((r) => setTimeout(r, 300));
    const texts = (await eva.app.history.listMessages(conv)).map((m) => m.text);
    expect(texts.filter((t) => t === 'Fabiorecon entrou no grupo')).toHaveLength(1);

    // Removida enquanto desconectada: descobre ao voltar.
    eva.app.pause();
    await until(() => (eva.app.getState().online ? undefined : true));
    await ana.app.removeGroupMember(gid, eva.id);
    eva.app.resume();
    await notice(eva, conv, 'Você não faz mais parte deste grupo');

    for (const u of [ana, eva, fabio]) u.app.pause();
  });
});
