export interface Lzma {
	decompress(data: Uint8Array): Promise<Uint8Array>;
	compress(data: Uint8Array): Promise<Uint8Array>;
}

const FFS_HEADER = 24;
const SECTION_HEADER = 4;

export const SEC_GUID_DEFINED = 0x02;
const SEC_PE32 = 0x10;
export const SEC_RAW = 0x19;
const SEC_FV_IMAGE = 0x17;

export const LZMA_SECTION_GUID = "ee4e5898-3914-4259-9d6e-dc7bd79403cf";

export const MODULES = {
	screen: "43e7abdd-e352-4cfb-a230-4cdc1d350e5c",
	popups: "348c4d62-bfbd-4882-9ece-c80bb1c4783b",
} as const;

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32 = (b: Uint8Array, o: number) =>
	(b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

export function guidAt(b: Uint8Array, o: number): string {
	const h = (n: number) => n.toString(16).padStart(2, "0");
	const le = (s: number, n: number) => {
		let out = "";
		for (let i = n - 1; i >= 0; i--) out += h(b[o + s + i]!);
		return out;
	};
	let tail = "";
	for (let i = 8; i < 16; i++) tail += h(b[o + i]!);
	return `${le(0, 4)}-${le(4, 2)}-${le(6, 2)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}

const align = (n: number, to: number) => (n + to - 1) & ~(to - 1);

export interface Section {
	type: number;

	start: number;

	body: number;
	end: number;
}

export function walkSections(buf: Uint8Array, from: number, to: number): Section[] {
	const out: Section[] = [];
	let p = from;
	while (p + SECTION_HEADER <= to) {
		const size = u24(buf, p);
		if (size < SECTION_HEADER || p + size > to) break;
		out.push({ type: buf[p + 3]!, start: p, body: p + SECTION_HEADER, end: p + size });
		p = align(p + size, 4);
	}
	return out;
}

export interface FfsFile {
	guid: string;
	type: number;
	start: number;
	body: number;
	end: number;
}

export function walkVolume(buf: Uint8Array, fvStart: number): { files: FfsFile[]; fvSize: number } {
	if (String.fromCharCode(...buf.subarray(fvStart + 40, fvStart + 44)) !== "_FVH")
		throw new Error("not a firmware volume");

	const fvSize = u32(buf, fvStart + 32);
	const headerLength = u16(buf, fvStart + 48);
	const extOffset = u16(buf, fvStart + 52);

	let p = fvStart + headerLength;
	if (extOffset) {
		const extSize = u32(buf, fvStart + extOffset + 16);
		p = fvStart + align(extOffset + extSize, 8);
	}

	const files: FfsFile[] = [];
	const fvEnd = fvStart + fvSize;
	while (p + FFS_HEADER <= fvEnd) {
		let erased = true;
		for (let i = 0; i < 16; i++)
			if (buf[p + i] !== 0xff) {
				erased = false;
				break;
			}
		if (erased) break;

		const size = u24(buf, p + 0x14);
		if (size < FFS_HEADER || p + size > fvEnd) break;
		files.push({ guid: guidAt(buf, p), type: buf[p + 0x12]!, start: p, body: p + FFS_HEADER, end: p + size });
		p = align(p + size, 8);
	}
	return { files, fvSize };
}

export interface Container {
	rom: Uint8Array;

	compressedStart: number;
	compressedEnd: number;

	payload: Uint8Array;

	innerFvStart: number;
	files: FfsFile[];
}

export async function openContainer(rom: Uint8Array, lzma: Lzma): Promise<Container> {
	const files = volumeStarts(rom).flatMap((start) => {
		try {
			return walkVolume(rom, start).files;
		} catch {
			return [];
		}
	});

	for (const file of files) {
		for (const sec of walkSections(rom, file.body, file.end)) {
			if (sec.type !== SEC_GUID_DEFINED) continue;
			if (guidAt(rom, sec.body) !== LZMA_SECTION_GUID) continue;

			const dataOffset = u16(rom, sec.body + 16);
			const compressedStart = sec.start + dataOffset;
			const payload = await lzma.decompress(rom.subarray(compressedStart, sec.end));

			const inner = walkSections(payload, 0, payload.length).find((s) => s.type === SEC_FV_IMAGE);
			if (!inner) continue;

			return {
				rom,
				compressedStart,
				compressedEnd: sec.end,
				payload,
				innerFvStart: inner.body,
				files: walkVolume(payload, inner.body).files,
			};
		}
	}
	throw new Error("compressed DXE volume not found, is this a BC-250 BIOS?");
}

function volumeStarts(rom: Uint8Array): number[] {
	const out: number[] = [];
	for (let i = 0; i + 44 < rom.length; i += 8) {
		if (rom[i + 40] === 0x5f && rom[i + 41] === 0x46 && rom[i + 42] === 0x56 && rom[i + 43] === 0x48)
			out.push(i);
	}
	if (!out.length) throw new Error("no firmware volume in this file");
	return out;
}

export interface Budget {
	compressed: number;

	compressedSlack: number;

	volumeSlack: number;

	volumeSize: number;
}

export function measureBudget(c: Container): Budget {
	const file = fileHolding(c.rom, c.compressedStart);
	let slack = 0;
	while (file.end + slack < c.rom.length && c.rom[file.end + slack] === 0xff) slack++;

	const { files, fvSize } = walkVolume(c.payload, c.innerFvStart);
	const last = files[files.length - 1];
	const used = last ? align(last.end - c.innerFvStart, 8) : 0;

	return {
		compressed: c.compressedEnd - c.compressedStart,
		compressedSlack: slack,
		volumeSlack: fvSize - used,
		volumeSize: fvSize,
	};
}

function fileHolding(rom: Uint8Array, offset: number): FfsFile {
	for (const start of volumeStarts(rom)) {
		try {
			const hit = walkVolume(rom, start).files.find((f) => f.start < offset && offset < f.end);
			if (hit) return hit;
		} catch {
		}
	}
	throw new Error("lost the file that holds the compressed volume");
}

export function sectionOf(c: Container, guid: string, type: number): { start: number; end: number } | null {
	const file = c.files.find((f) => f.guid === guid.toLowerCase());
	if (!file) return null;
	const sec = walkSections(c.payload, file.body, file.end).find((s) => s.type === type);
	return sec ? { start: sec.body, end: sec.end } : null;
}

export const moduleBody = (c: Container, guid: string) => sectionOf(c, guid, SEC_PE32);
export const rawBody = (c: Container, guid: string) => sectionOf(c, guid, SEC_RAW);

export async function sealContainer(c: Container, lzma: Lzma): Promise<Uint8Array> {
	const compressed = await lzma.compress(c.payload);

	const rom = c.rom;
	const secStart = findSectionStart(rom, c.compressedStart);
	const file = volumeStarts(rom).flatMap((s) => { try { return walkVolume(rom, s).files; } catch { return []; } }).find(
		(f) => f.start < secStart && secStart < f.end,
	);
	if (!file) throw new Error("lost the file that holds the compressed volume");

	const headerBytes = c.compressedStart - secStart;
	const newSectionSize = headerBytes + compressed.length;
	const newFileSize = file.body - file.start + (secStart - file.body) + newSectionSize;
	const room = file.end - file.start;
	const grew = newFileSize - room;

	const out = new Uint8Array(rom);
	if (grew > 0) {
		let free = 0;
		while (file.end + free < rom.length && rom[file.end + free] === 0xff) free++;
		if (grew > free)
			throw new Error(`recompressed image needs ${grew} more bytes than the volume has free`);
	}

	out.set(compressed, c.compressedStart);

	for (let i = c.compressedStart + compressed.length; i < c.compressedEnd; i++) out[i] = 0xff;

	writeU24(out, secStart, newSectionSize);
	writeU24(out, file.start + 0x14, newFileSize);
	out[file.start + 0x10] = ffsHeaderChecksum(out, file.start);
	return out;
}

function findSectionStart(rom: Uint8Array, bodyStart: number): number {
	return bodyStart - 24 >= 0 && u24(rom, bodyStart - 24) > 0 ? bodyStart - 24 : bodyStart - 24;
}

function writeU24(b: Uint8Array, o: number, v: number) {
	b[o] = v & 0xff;
	b[o + 1] = (v >> 8) & 0xff;
	b[o + 2] = (v >> 16) & 0xff;
}

function ffsHeaderChecksum(b: Uint8Array, start: number): number {
	let sum = 0;
	for (let i = 0; i < 16; i++) sum += b[start + i]!;
	for (let i = 18; i < 23; i++) sum += b[start + i]!;
	return (0x100 - (sum & 0xff)) & 0xff;
}
