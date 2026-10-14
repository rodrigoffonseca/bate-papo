import { describe, expect, it } from 'vitest';

import { usernameProblem } from '../src/core/validation';

describe('validação de nome de usuário', () => {
  it('aceita os mesmos nomes que o servidor', () => {
    for (const ok of ['maria', '@Joao_Silva', 'ana.b2']) expect(usernameProblem(ok)).toBeNull();
  });
  it('recusa com explicação', () => {
    expect(usernameProblem('ab')).toMatch(/3/);
    expect(usernameProblem('1abc')).toMatch(/letra/);
    expect(usernameProblem('joão')).toMatch(/acento/);
    expect(usernameProblem('maria..silva')).toMatch(/\.\./);
    expect(usernameProblem('maria.')).toMatch(/\.\./);
  });
});
