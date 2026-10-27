// Arquivos de mídia no aparelho, com o expo-file-system.
// - documentos/media: anexos **cifrados** (a chave fica no banco SQLCipher);
// - cache/media-tmp: cópias decifradas temporárias para os players de vídeo e
//   áudio, apagadas ao sair da tela e a cada abertura do app.

import { Directory, File, Paths } from 'expo-file-system';

import type { MediaStore } from '@/core/media';

const mediaDir = new Directory(Paths.document, 'media');
const tempDir = new Directory(Paths.cache, 'media-tmp');

function ensure(dir: Directory): Directory {
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

function randomName(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
}

export const deviceMediaStore: MediaStore = {
  async save(key, ciphertext) {
    new File(ensure(mediaDir), key).write(ciphertext);
  },
  async read(key) {
    const f = new File(mediaDir, key);
    return f.exists ? f.bytes() : null;
  },
  async delete(key) {
    const f = new File(mediaDir, key);
    if (f.exists) f.delete();
  },
  async clear() {
    if (mediaDir.exists) mediaDir.delete();
    if (tempDir.exists) tempDir.delete();
  },
  async writeTemp(bytes, extension) {
    const f = new File(ensure(tempDir), `${randomName()}.${extension}`);
    f.write(bytes);
    return f.uri;
  },
  async deleteTemp(uri) {
    const f = new File(uri);
    // Só apaga dentro da pasta temporária.
    if (f.uri.startsWith(tempDir.uri) && f.exists) f.delete();
  },
  async clearTemp() {
    if (tempDir.exists) tempDir.delete();
  },
};
