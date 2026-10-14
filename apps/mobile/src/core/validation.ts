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
