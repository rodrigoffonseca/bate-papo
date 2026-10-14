/** Mesmas regras do servidor (server/internal/username). */
export function usernameProblem(raw: string): string | null {
  const u = raw.trim().replace(/^@/, '').toLowerCase();
  if (u.length < 3) return 'Use pelo menos 3 caracteres.';
  if (u.length > 32) return 'Use no máximo 32 caracteres.';
  if (!/^[a-z]/.test(u)) return 'Comece com uma letra.';
  if (!/^[a-z0-9_.]+$/.test(u)) return 'Use apenas letras sem acento, números, "_" e ".".';
  if (u.includes('..') || u.endsWith('.')) return 'Não use ".." nem termine com ".".';
  return null;
}

/** Mesmas regras do servidor (server/internal/api/pin.go). */
export function pinProblem(pin: string): string | null {
  const r = [...pin];
  const n = r.length;
  if (n < 6) return 'Use pelo menos 6 caracteres.';
  if (n > 64) return 'Use no máximo 64 caracteres.';
  const codes = r.map((c) => c.codePointAt(0)!);
  const step = (d: number) => codes.every((c, i) => i === 0 || c - codes[i - 1]! === d);
  if (step(1) || step(-1)) return 'Evite sequências como 123456.';
  for (let p = 1; p <= n / 2; p++) {
    if (n % p === 0 && r.slice(0, p).join('').repeat(n / p) === pin) return 'Evite repetições como 111111 ou 121212.';
  }
  if (['112233', '102030', '159753', '147258', '100200'].includes(pin)) return 'Esse PIN é muito comum.';
  return null;
}
