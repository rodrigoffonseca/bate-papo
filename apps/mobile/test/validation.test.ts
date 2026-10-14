import { describe, expect, it } from 'vitest';

import { pinProblem, usernameProblem } from '../src/core/validation';

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

describe('validação do PIN (igual ao servidor)', () => {
  it('aceita PINs razoáveis', () => {
    for (const ok of ['284917', '93a!kd', 'minha senha forte', '142857', 'pão-de-queijo']) expect(pinProblem(ok)).toBeNull();
  });
  it('recusa PINs fracos', () => {
    for (const bad of ['12345', '123456', '654321', '111111', '121212', '123123', 'abcdef', '112233', 'çççççç', '9'.repeat(65)]) {
      expect(pinProblem(bad)).not.toBeNull();
    }
  });
});
