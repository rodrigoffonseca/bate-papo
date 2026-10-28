// Número de segurança: 60 dígitos calculados das chaves de identidade das
// duas pessoas. Se os dois celulares mostram o mesmo número, ninguém está no
// meio da conversa. O QR code leva o mesmo número, para conferir com a câmera.

const QR_PREFIX = 'batepapo-sn:1:';

/**
 * Situação da verificação de um contato:
 * - verified: conferido, e a chave continua a mesma;
 * - unverified: nunca conferido;
 * - changed: foi conferido, mas a chave mudou depois (confira de novo).
 */
export type VerificationState = 'verified' | 'unverified' | 'changed';

export function safetyQrPayload(safetyNumber: string): string {
  return QR_PREFIX + safetyNumber;
}

/** Extrai o número de um QR lido; null se não for um código do Bate-Papo. */
export function parseSafetyQr(data: string): string | null {
  if (!data.startsWith(QR_PREFIX)) return null;
  const n = data.slice(QR_PREFIX.length);
  if (n.length !== 60) return null;
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if (c < 48 || c > 57) return null;
  }
  return n;
}

/** Os 60 dígitos em 12 blocos de 5, como se lê em voz alta. */
export function safetyNumberBlocks(safetyNumber: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < safetyNumber.length; i += 5) out.push(safetyNumber.slice(i, i + 5));
  return out;
}
