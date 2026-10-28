import { create } from 'qrcode';
import { useMemo } from 'react';
import { View } from 'react-native';

/**
 * QR code desenhado com Views (sem SVG nem imagens). Módulos escuros vizinhos
 * na mesma linha viram um só retângulo, para não criar milhares de Views.
 * Sempre preto no branco, com margem, para qualquer câmera ler.
 */
export function QrCode({ value, size = 240 }: { value: string; size?: number }) {
  const { count, rows } = useMemo(() => {
    const m = create(value, { errorCorrectionLevel: 'M' }).modules;
    const runs: { start: number; length: number }[][] = [];
    for (let r = 0; r < m.size; r++) {
      const row: { start: number; length: number }[] = [];
      for (let c = 0; c < m.size; c++) {
        if (!m.get(r, c)) continue;
        const last = row[row.length - 1];
        if (last && last.start + last.length === c) last.length++;
        else row.push({ start: c, length: 1 });
      }
      runs.push(row);
    }
    return { count: m.size, rows: runs };
  }, [value]);

  const quiet = 4; // margem exigida pelo padrão, em módulos
  const cell = size / (count + quiet * 2);
  return (
    <View style={{ width: size, height: size, backgroundColor: '#fff', padding: cell * quiet }}>
      {rows.map((row, r) => (
        <View key={r} style={{ height: cell, flexDirection: 'row' }}>
          {row.map((run) => (
            <View
              key={run.start}
              style={{
                position: 'absolute',
                left: run.start * cell,
                width: run.length * cell + 0.5, // evita frestas por arredondamento
                height: cell + 0.5,
                backgroundColor: '#000',
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
