// Câmera, galeria e preparo da mídia antes de cifrar: fotos são reduzidas e
// recomprimidas (o que também descarta metadados como localização GPS);
// fotos e vídeos ganham uma miniatura pequena que vai dentro da mensagem.

import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import * as VideoThumbnails from 'expo-video-thumbnails';

import { MEDIA_LIMITS, MediaTooLargeError, type MediaInput } from '@/core/service';

const MAX_PHOTO_SIDE = 1600;
const THUMB_SIDE = 64;
const MAX_VIDEO_SECONDS = 180;

const pickerOptions: ImagePicker.ImagePickerOptions = {
  mediaTypes: ['images', 'videos'],
  quality: 1, // a compressão é feita depois, com controle do tamanho
  videoMaxDuration: MAX_VIDEO_SECONDS,
  allowsEditing: false,
  exif: false,
};

export class PermissionDeniedError extends Error {
  constructor(what: string) {
    super(`Sem permissão para usar ${what}. Libere nas configurações do celular.`);
    this.name = 'PermissionDeniedError';
  }
}

/** Abre a galeria. Devolve null se a pessoa cancelar. */
export async function pickFromGallery(): Promise<ImagePicker.ImagePickerAsset | null> {
  const r = await ImagePicker.launchImageLibraryAsync(pickerOptions);
  return r.canceled ? null : (r.assets[0] ?? null);
}

/** Abre a câmera (foto ou vídeo). Devolve null se a pessoa cancelar. */
export async function takeWithCamera(): Promise<ImagePicker.ImagePickerAsset | null> {
  const perm = await ImagePicker.requestCameraPermissionsAsync();
  if (!perm.granted) throw new PermissionDeniedError('a câmera');
  const r = await ImagePicker.launchCameraAsync(pickerOptions);
  return r.canceled ? null : (r.assets[0] ?? null);
}

/** Miniatura JPEG minúscula em base64, a partir de uma imagem local. */
async function thumbnailOf(uri: string, width: number, height: number): Promise<string | undefined> {
  try {
    const landscape = width >= height;
    const ctx = ImageManipulator.manipulate(uri).resize(landscape ? { width: THUMB_SIDE } : { height: THUMB_SIDE });
    const img = await ctx.renderAsync();
    const out = await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.5, base64: true });
    return out.base64 ?? undefined;
  } catch {
    return undefined; // sem miniatura, a mensagem segue normalmente
  }
}

/** Lê o arquivo escolhido e prepara foto ou vídeo para envio. */
export async function prepareAsset(asset: ImagePicker.ImagePickerAsset): Promise<MediaInput> {
  if (asset.type === 'video') {
    const file = new File(asset.uri);
    const size = asset.fileSize ?? file.size ?? 0;
    if (size > MEDIA_LIMITS.video) throw new MediaTooLargeError('video', MEDIA_LIMITS.video);
    let thumbnail: string | undefined;
    try {
      const frame = await VideoThumbnails.getThumbnailAsync(asset.uri, { time: 0 });
      thumbnail = await thumbnailOf(frame.uri, frame.width, frame.height);
      new File(frame.uri).delete();
    } catch {
      thumbnail = undefined;
    }
    return {
      kind: 'video',
      bytes: await file.bytes(),
      mime: asset.mimeType ?? 'video/mp4',
      width: asset.width,
      height: asset.height,
      ...(asset.duration ? { durationMs: Math.round(asset.duration) } : {}),
      ...(thumbnail && { thumbnail }),
    };
  }

  // Foto: reduz para no máximo 1600 px no maior lado e recomprime em JPEG.
  const landscape = asset.width >= asset.height;
  const scale = Math.min(1, MAX_PHOTO_SIDE / Math.max(asset.width, asset.height));
  const ctx = ImageManipulator.manipulate(asset.uri);
  if (scale < 1) ctx.resize(landscape ? { width: MAX_PHOTO_SIDE } : { height: MAX_PHOTO_SIDE });
  const img = await ctx.renderAsync();
  const saved = await img.saveAsync({ format: SaveFormat.JPEG, compress: 0.8 });
  const file = new File(saved.uri);
  const bytes = await file.bytes();
  file.delete();
  return {
    kind: 'image',
    bytes,
    mime: 'image/jpeg',
    width: saved.width,
    height: saved.height,
    thumbnail: await thumbnailOf(asset.uri, asset.width, asset.height),
  };
}
