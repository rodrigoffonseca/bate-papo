// Utilitários de bytes sem dependências de plataforma (Node, navegador e
// React Native).

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function u32(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) throw new RangeError('u32 fora do intervalo');
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
}

export function readU32(b: Uint8Array, off: number): number {
  if (off + 4 > b.length) throw new Error('mensagem truncada');
  return new DataView(b.buffer, b.byteOffset + off, 4).getUint32(0);
}

// UTF-8 implementado aqui porque nem todo motor JavaScript (ex.: Hermes, do
// React Native) oferece TextDecoder com validação estrita.
export const utf8 = {
  encode(s: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
      let c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
        const d = s.charCodeAt(i + 1);
        if (d >= 0xdc00 && d <= 0xdfff) {
          c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00);
          i++;
        }
      }
      if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd; // substituto isolado
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return Uint8Array.from(out);
  },

  /** Decodifica UTF-8 estrito: lança erro em sequências inválidas. */
  decode(b: Uint8Array): string {
    let out = '';
    for (let i = 0; i < b.length; ) {
      const x = b[i]!;
      let c: number;
      let n: number;
      let min: number;
      if (x < 0x80) [c, n, min] = [x, 0, 0];
      else if ((x & 0xe0) === 0xc0) [c, n, min] = [x & 0x1f, 1, 0x80];
      else if ((x & 0xf0) === 0xe0) [c, n, min] = [x & 0x0f, 2, 0x800];
      else if ((x & 0xf8) === 0xf0) [c, n, min] = [x & 0x07, 3, 0x10000];
      else throw new Error('UTF-8 inválido');
      for (let k = 1; k <= n; k++) {
        const y = b[i + k];
        if (y === undefined || (y & 0xc0) !== 0x80) throw new Error('UTF-8 inválido');
        c = (c << 6) | (y & 0x3f);
      }
      if (c < min || c > 0x10ffff || (c >= 0xd800 && c <= 0xdfff)) throw new Error('UTF-8 inválido');
      out += String.fromCodePoint(c);
      i += n + 1;
    }
    return out;
  },
};

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Map([...B64].map((c, i) => [c, i]));

export function toBase64(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i]! << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
    out += i + 1 < b.length ? B64[(n >> 6) & 63]! : '=';
    out += i + 2 < b.length ? B64[n & 63]! : '=';
  }
  return out;
}

export function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, '');
  if (clean.length % 4 === 1) throw new Error('base64 inválido');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let j = 0;
  for (const c of clean) {
    const v = B64_LOOKUP.get(c);
    if (v === undefined) throw new Error('base64 inválido');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[j++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
