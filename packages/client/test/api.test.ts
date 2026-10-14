import { describe, expect, it } from 'vitest';

import { Api } from '../src/api.js';

describe('Api', () => {
  it('remove barras finais do endereço do servidor', () => {
    expect(new Api('http://a/b///').baseUrl).toBe('http://a/b');
    expect(new Api('http://a').baseUrl).toBe('http://a');
  });

  it('não fica lenta com muitas barras no endereço', () => {
    const start = Date.now();
    new Api('http://x' + '/'.repeat(100_000) + 'a');
    expect(Date.now() - start).toBeLessThan(100);
  });
});
