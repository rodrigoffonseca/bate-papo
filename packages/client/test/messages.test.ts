import { describe, expect, it } from 'vitest';

import { MAX_THUMBNAIL_CHARS, validatePayload } from '../src/messages.js';

const base = { v: 1, id: 'm1', senderRegistrationId: 7, sentAt: 1 };
const attachment = { id: 'a', key: 'k', digest: 'd', mime: 'video/mp4', size: 10 };

describe('validação do conteúdo recebido', () => {
  it('aceita vídeo com miniatura', () => {
    const p = validatePayload({ ...base, kind: 'video', attachment: { ...attachment, durationMs: 3000, thumbnail: 'abc' } });
    expect(p.attachment?.thumbnail).toBe('abc');
  });

  it('descarta miniatura grande demais sem perder a mensagem', () => {
    const p = validatePayload({
      ...base,
      kind: 'image',
      attachment: { ...attachment, thumbnail: 'x'.repeat(MAX_THUMBNAIL_CHARS + 1) },
    });
    expect(p.attachment?.thumbnail).toBeUndefined();
  });

  it('recusa anexos malformados', () => {
    expect(() => validatePayload({ ...base, kind: 'voice' })).toThrow();
    expect(() => validatePayload({ ...base, kind: 'video', attachment: { ...attachment, size: '10' } })).toThrow();
    expect(() => validatePayload({ ...base, kind: 'image', attachment: { ...attachment, width: -1 } })).toThrow();
    expect(() => validatePayload({ ...base, kind: 'gif', attachment })).toThrow();
  });
});
