/**
 * RSA 自签证书生成（design.md D6）。零依赖：RSA 密钥对用 WebCrypto 生成，
 * 自签 X.509 证书用最小 DER 手工装配（仅测试用途）。
 */

export interface CertPair {
  certPem: string;
  keyPem: string;
}

function toDer(bits: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return new Uint8Array(bytes);
}

function pem(tag: string, der: Uint8Array): string {
  const b64 = btoa(String.fromCharCode(...der));
  const lines = b64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${tag}-----\n${lines.join('\n')}\n-----END ${tag}-----\n`;
}

// ---------- DER 编码基础 ----------

function len(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  let v = n;
  while (v > 0) {
    bytes.unshift(v & 0xff);
    v >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function tlv(tag: number, content: Uint8Array | number[]): Uint8Array {
  const c = Array.isArray(content) ? content : Array.from(content);
  return new Uint8Array([tag, ...len(c.length), ...c]);
}

function int(n: bigint | number): Uint8Array {
  let v = BigInt(n);
  const bytes: number[] = [];
  while (v > 0n) {
    bytes.unshift(Number(v & 0xffn));
    v >>= 8n;
  }
  if (bytes.length === 0 || (bytes[0] as number) > 0x7f) bytes.unshift(0);
  return tlv(0x02, bytes);
}

function seq(...parts: Uint8Array[]): Uint8Array {
  return tlv(0x30, parts.flatMap((p) => Array.from(p)));
}

function raw(tag: number, bytes: number[]): Uint8Array {
  return tlv(tag, bytes);
}

/** 生成 RSA-2048 自签证书（CN=localhost，1 天有效期），PKCS#8 私钥导出 */
export async function generateSelfSignedCert(): Promise<CertPair> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  const spki = await crypto.subtle.exportKey('spki', pair.publicKey);
  const keyPem = pem('PRIVATE KEY', new Uint8Array(pkcs8));

  // TBSCertificate
  const version = tlv(0xa0, Array.from(int(2))); // v3: [0] { INTEGER 2 }
  const serial = int(Date.now() % 0x7fffffff);
  const sigAlg = seq(raw(0x06, [1, 2, 840, 113549, 1, 1, 11]), raw(0x05, [])); // sha256WithRSA
  const nameCn = tlv(0x30, [
    ...Array.from(raw(0x06, [2, 5, 4, 3])),
    ...Array.from(tlv(0x0c, Array.from(new TextEncoder().encode('localhost')))),
  ]);
  // Name ::= SEQUENCE OF RelativeDistinguishedName；RDN ::= SET OF AttributeTypeAndValue
  const name = tlv(0x30, Array.from(tlv(0x31, Array.from(nameCn))));
  const issuer = name;
  const now = Math.floor(Date.now() / 1000) - 3600;
  const expiry = now + 86400;
  const time = (t: number): Uint8Array => {
    const d = new Date(t * 1000);
    const p = (n: number): string => String(n).padStart(2, '0');
    const s = `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
      `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
    return tlv(0x17, Array.from(new TextEncoder().encode(s)));
  };
  const validity = seq(time(now), time(expiry));
  const subject = issuer;
  const spkiBytes = new Uint8Array(spki);
  const tbs = seq(version, serial, sigAlg, issuer, validity, subject, spkiBytes);
  const signature = new Uint8Array(
    await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, tbs as unknown as BufferSource),
  );
  const cert = seq(tbs, sigAlg, tlv(0x03, [0, ...Array.from(signature)]));
  void toDer;
  return { certPem: pem('CERTIFICATE', cert), keyPem };
}
