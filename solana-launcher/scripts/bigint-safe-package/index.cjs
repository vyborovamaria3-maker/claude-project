'use strict';

// Only JavaScript BigInt is used. There are no native bindings or install hooks.
function toBigIntBE(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Expected bytes');
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}
function toBigIntLE(bytes) {
  return toBigIntBE(Uint8Array.from(bytes).reverse());
}
function toBufferBE(value, width) {
  if (typeof value !== 'bigint' || value < 0n) throw new RangeError('Expected unsigned bigint');
  if (!Number.isSafeInteger(width) || width < 0 || width > 1024) throw new RangeError('Invalid width');
  if (value >> BigInt(width * 8)) throw new RangeError('Value does not fit buffer');
  const result = Buffer.alloc(width);
  for (let index = width - 1; index >= 0; index--) {
    result[index] = Number(value & 255n);
    value >>= 8n;
  }
  return result;
}
function toBufferLE(value, width) {
  return toBufferBE(value, width).reverse();
}
exports.toBigIntBE = toBigIntBE;
exports.toBigIntLE = toBigIntLE;
exports.toBufferBE = toBufferBE;
exports.toBufferLE = toBufferLE;
