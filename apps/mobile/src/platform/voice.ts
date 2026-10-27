// Gravação de mensagens de voz (AAC mono em .m4a, igual em Android e iOS).
// O arquivo gravado (não cifrado) é lido e apagado logo em seguida.

import {
  RecordingPresets,
  requestRecordingPermissionsAsync,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import { File } from 'expo-file-system';
import { useState } from 'react';

import type { MediaInput } from '@/core/service';

import { PermissionDeniedError } from './pick-media';

const VOICE_PRESET = { ...RecordingPresets.HIGH_QUALITY, numberOfChannels: 1, bitRate: 48_000 };
/** Gravações mais curtas que isso são tratadas como toque acidental. */
const MIN_VOICE_MS = 700;

export function useVoiceRecorder() {
  const recorder = useAudioRecorder(VOICE_PRESET);
  const state = useAudioRecorderState(recorder, 200);
  const [recording, setRecording] = useState(false);

  const finish = async (): Promise<{ bytes: Uint8Array; durationMs: number } | null> => {
    const durationMs = state.durationMillis;
    await recorder.stop();
    setRecording(false);
    await setAudioModeAsync({ allowsRecording: false, playsInSilentMode: true });
    if (!recorder.uri) return null;
    const file = new File(recorder.uri);
    const bytes = file.exists ? await file.bytes() : null;
    if (file.exists) file.delete();
    return bytes ? { bytes, durationMs } : null;
  };

  return {
    recording,
    durationMs: state.durationMillis,

    async start() {
      const perm = await requestRecordingPermissionsAsync();
      if (!perm.granted) throw new PermissionDeniedError('o microfone');
      await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      await recorder.prepareToRecordAsync();
      recorder.record();
      setRecording(true);
    },

    /** Para e devolve a mensagem de voz pronta para envio (ou null se curta demais). */
    async stop(): Promise<MediaInput | null> {
      const r = await finish();
      if (!r || r.durationMs < MIN_VOICE_MS) return null;
      return { kind: 'voice', bytes: r.bytes, mime: 'audio/mp4', durationMs: r.durationMs };
    },

    /** Descarta a gravação. */
    async cancel() {
      await finish();
    },
  };
}
