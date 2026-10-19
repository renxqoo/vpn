const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** 受控读取：超过 maxBytes 抛错（Content-Length 预检 + 流式累计） */
export async function readBodyBounded(r: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<Uint8Array> {
  const declared = Number(r.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await r.body?.cancel();
    } catch (_e) {
      /* noop */
    }
    throw new Error(`response too large: ${declared} > ${maxBytes}`);
  }
  const reader = r.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch (_e) {
          /* noop */
        }
        throw new Error(`response exceeded ${maxBytes} bytes during stream`);
      }
      parts.push(value);
    }
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** 受控文本读取 */
export async function readTextBounded(r: Response, maxBytes = MAX_RESPONSE_BYTES): Promise<string> {
  return new TextDecoder().decode(await readBodyBounded(r, maxBytes));
}
