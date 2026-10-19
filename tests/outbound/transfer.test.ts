import { expect, test } from 'bun:test';
import { AnytlsSession } from '../../src/outbound/anytls/session.ts';
import { CMD, encodeFrame } from '../../src/outbound/anytls/frame.ts';
import { DEFAULT_PADDING_SCHEME, makePaddingFactory } from '../../src/outbound/anytls/padding.ts';

function session() {
  const padding = makePaddingFactory(DEFAULT_PADDING_SCHEME)!;
  return new AnytlsSession({ write: (data: Uint8Array) => data.length, end() {} } as unknown as Bun.Socket<undefined>,
    1, 'test', {
      hooks: { onDead() {}, onUpdatePaddingScheme: () => false, onAlert() {} },
      padding: () => padding, clientName: 'transfer-test',
    });
}

test('receive fast path handles offsets, consecutive frames, fragmented tails and partial reads', async () => {
  const sess = session();
  const stream = sess.openStream();
  try {
    const one = encodeFrame(CMD.psh, stream.sid, new TextEncoder().encode('abcdef'));
    const two = encodeFrame(CMD.psh, stream.sid, new TextEncoder().encode('ghijkl'));
    const packet = Buffer.concat([Buffer.alloc(9, 255), one, two.subarray(0, 10)]);
    sess.feedData(packet.subarray(9));
    expect(new TextDecoder().decode(await stream.read(2))).toBe('ab');
    sess.feedData(Buffer.from(two.subarray(10)));
    expect(new TextDecoder().decode(await stream.read(7))).toBe('cdefghi');
    expect(new TextDecoder().decode(await stream.read())).toBe('jkl');
    const waiting = stream.read(2);
    const three = encodeFrame(CMD.psh, stream.sid, new TextEncoder().encode('mnop'));
    for (const byte of three) sess.feedData(Buffer.from([byte]));
    expect(new TextDecoder().decode(await waiting)).toBe('mn');
    expect(new TextDecoder().decode(await stream.read())).toBe('op');
  } finally { sess.close(); }
});
