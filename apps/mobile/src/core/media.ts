// Arquivos de mídia no aparelho. Ficam guardados **cifrados** (exatamente como
// vieram do servidor ou foram enviados); só são decifrados na hora de
// mostrar. Vídeos e áudios precisam de um arquivo para o player: esses
// arquivos temporários decifrados são apagados ao sair da tela e ao abrir o app.

export interface MediaStore {
  save(key: string, ciphertext: Uint8Array): Promise<void>;
  read(key: string): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  /** Apaga todos os arquivos (sair da conta). */
  clear(): Promise<void>;
  /** Grava um arquivo temporário decifrado e devolve seu URI. */
  writeTemp(bytes: Uint8Array, extension: string): Promise<string>;
  deleteTemp(uri: string): Promise<void>;
  clearTemp(): Promise<void>;
}

/** Nome do arquivo de um anexo: remetente + ID da mensagem, só com caracteres seguros. */
export function mediaKey(senderId: string, messageId: string): string {
  return `${senderId}_${messageId}`.replace(/[^A-Za-z0-9_-]/g, '');
}

/** Extensão de arquivo a partir do tipo MIME (para o player reconhecer o formato). */
export function extensionFor(mime: string): string {
  const known: Record<string, string> = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/heic': 'heic',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'audio/mp4': 'm4a',
    'audio/m4a': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/mpeg': 'mp3',
    'audio/ogg': 'ogg',
    'audio/webm': 'webm',
  };
  return known[mime.split(';')[0]!.trim().toLowerCase()] ?? 'bin';
}

/** Implementação em memória, para testes. */
export class MemoryMediaStore implements MediaStore {
  readonly files = new Map<string, Uint8Array>();
  readonly temps = new Map<string, Uint8Array>();
  private seq = 0;

  async save(key: string, ciphertext: Uint8Array) {
    this.files.set(key, ciphertext.slice());
  }
  async read(key: string) {
    return this.files.get(key) ?? null;
  }
  async delete(key: string) {
    this.files.delete(key);
  }
  async clear() {
    this.files.clear();
    this.temps.clear();
  }
  async writeTemp(bytes: Uint8Array, extension: string) {
    const uri = `memory://tmp/${++this.seq}.${extension}`;
    this.temps.set(uri, bytes.slice());
    return uri;
  }
  async deleteTemp(uri: string) {
    this.temps.delete(uri);
  }
  async clearTemp() {
    this.temps.clear();
  }
}
