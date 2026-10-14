import { describe, expect, it } from 'vitest';

import { History, directConversationId } from '../src/core/history';
import { migrate } from '../src/core/sql';
import { nodeSql } from './node-sql';

async function setup() {
  const db = nodeSql();
  await migrate(db);
  await migrate(db); // idempotente
  return new History(db, () => 'me');
}

describe('histórico local', () => {
  it('guarda mensagens recebidas e enviadas na mesma conversa', async () => {
    const h = await setup();
    await h.upsertContact({ id: 'ana', username: 'ana', displayName: 'Ana' });
    await h.saveIncoming({ from: 'ana', id: 'm1', kind: 'text', text: 'oi', sentAt: 1000 }, { read: false });
    await h.saveOutgoing({ to: 'ana', id: 'm2', text: 'olá!', sentAt: 2000 });

    const [conv] = await h.listConversations();
    expect(conv).toMatchObject({ id: directConversationId('ana'), title: 'Ana', lastText: 'olá!', unread: 1 });

    const msgs = await h.listMessages(conv!.id);
    expect(msgs.map((m) => [m.id, m.outgoing, m.status])).toEqual([
      ['m2', true, 'sending'],
      ['m1', false, 'received'],
    ]);

    await h.setOutgoingStatus('m2', 'sent');
    await h.markRead(conv!.id);
    expect((await h.listConversations())[0]).toMatchObject({ unread: 0 });
    expect((await h.listMessages(conv!.id))[0]!.status).toBe('sent');
  });

  it('ignora mensagens repetidas', async () => {
    const h = await setup();
    const m = { from: 'bia', id: 'x', kind: 'text', text: 'oi', sentAt: 1 };
    expect(await h.saveIncoming(m, { read: false })).toBe(true);
    expect(await h.saveIncoming(m, { read: false })).toBe(false);
    expect((await h.listConversations())[0]!.unread).toBe(1);
  });

  it('não deixa um remetente sobrescrever mensagem de outro com o mesmo ID', async () => {
    const h = await setup();
    await h.saveIncoming({ from: 'ana', id: 'mesmo', kind: 'text', text: 'da Ana', sentAt: 1 }, { read: true });
    await h.saveIncoming({ from: 'eva', id: 'mesmo', kind: 'text', text: 'da Eva', sentAt: 2 }, { read: true });
    const ana = await h.listMessages(directConversationId('ana'));
    expect(ana.map((m) => m.text)).toEqual(['da Ana']);
  });

  it('ordena conversas pela mais recente e mostra título sem nome', async () => {
    const h = await setup();
    await h.saveIncoming({ from: 'a', id: '1', kind: 'text', text: 'antiga', sentAt: 1 }, { read: true });
    await h.saveIncoming({ from: 'b', id: '2', kind: 'text', text: 'nova', sentAt: 5 }, { read: true });
    // Mensagem antiga que chegou atrasada não muda a prévia.
    await h.saveIncoming({ from: 'b', id: '3', kind: 'text', text: 'atrasada', sentAt: 3 }, { read: true });
    const list = await h.listConversations();
    expect(list.map((c) => [c.peerId, c.lastText, c.title])).toEqual([
      ['b', 'nova', 'Contato'],
      ['a', 'antiga', 'Contato'],
    ]);
  });

  it('limpa tudo no logout', async () => {
    const h = await setup();
    await h.saveOutgoing({ to: 'a', id: '1', text: 'oi', sentAt: 1 });
    await h.clear();
    expect(await h.listConversations()).toEqual([]);
  });
});
