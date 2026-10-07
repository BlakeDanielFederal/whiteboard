/**
 * A random v4 UUID. Browsers withhold `crypto.randomUUID` from insecure
 * contexts, which a web host on a LAN address over plain HTTP is; they still
 * offer `crypto.getRandomValues`.
 */
export function randomId(
  cryptoApi: Pick<Crypto, "getRandomValues"> &
    Partial<Pick<Crypto, "randomUUID">> = globalThis.crypto,
): string {
  if (cryptoApi.randomUUID) return cryptoApi.randomUUID();

  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));

  // Version 4, RFC 9562 variant.
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;

  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
