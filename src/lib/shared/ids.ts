/**
 * UUIDv7 ids (T-04): 48-bit big-endian millisecond timestamp + random, so ids
 * sort by creation time (better index locality and cheaper "recent" queries
 * than v4) while staying globally unique.
 */
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function randomBytes(length: number): Uint8Array {
	return crypto.getRandomValues(new Uint8Array(length));
}

function toHex(bytes: Uint8Array): string {
	let out = '';
	for (const byte of bytes) out += HEX[byte];
	return out;
}

/** New UUIDv7 string, e.g. `0198xxxx-xxxx-7xxx-8xxx-xxxxxxxxxxxx`. */
export function uuidv7(now: number = Date.now()): string {
	const bytes = randomBytes(16);
	const ts = Math.max(0, Math.floor(now));
	bytes[0] = (ts / 2 ** 40) & 0xff;
	bytes[1] = (ts / 2 ** 32) & 0xff;
	bytes[2] = (ts / 2 ** 24) & 0xff;
	bytes[3] = (ts / 2 ** 16) & 0xff;
	bytes[4] = (ts / 2 ** 8) & 0xff;
	bytes[5] = ts & 0xff;
	bytes[6] = (bytes[6]! & 0x0f) | 0x70; // version 7
	bytes[8] = (bytes[8]! & 0x3f) | 0x80; // RFC 4122 variant
	const hex = toHex(bytes);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

/** Extract the embedded millisecond timestamp (NaN for non-v7 ids). */
export function timeFromUuidv7(id: string): number {
	const hex = id.replace(/-/g, '').slice(0, 12);
	return Number.parseInt(hex, 16) || Number.NaN;
}
