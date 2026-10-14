const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

/** Hora se for hoje, "Ontem", ou a data. */
export function formatListDate(ms: number, now = new Date()): string {
  const d = new Date(ms);
  if (sameDay(d, now)) return formatTime(ms);
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return 'Ontem';
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

/** Mensagem amigável a partir de um erro da API ou de rede. */
export function errorMessage(err: unknown): string {
  if (err && typeof err === 'object' && 'status' in err && typeof err.status === 'number') {
    if (err.status === 404) return 'Não encontramos ninguém com esse nome de usuário.';
    if (err.status === 429) return 'Muitas tentativas. Aguarde um pouco e tente de novo.';
  }
  if (err instanceof Error && err.message) {
    if (/network|fetch|sem rede|failed/i.test(err.message)) return 'Sem conexão com o servidor. Verifique sua internet.';
    return err.message.charAt(0).toUpperCase() + err.message.slice(1);
  }
  return 'Algo deu errado. Tente de novo.';
}
