import {
	MODULES,
	SEC_GUID_DEFINED,
	SEC_RAW,
	LZMA_SECTION_GUID,
	guidAt as guidOf,
	moduleBody,
	walkSections,
	type Container,
	type Lzma,
	type Section,
} from "./firmware.ts";

export const PALETTE_SIZE = 16;

export const ROLES: Record<number, string> = {
	0: "help and info text; POST background",
	1: "body text and default dialog background",
	2: "success dialogs",
	3: "unused",
	4: "error dialogs",
	5: "unused",
	6: "unused",
	7: "body background; selected row text",
	8: "unused",
	9: "POST console messages",
	10: "POST console messages",
	11: "POST console messages",
	12: "POST console messages",
	13: "POST console messages",
	14: "POST console messages",
	15: "section titles; POST foreground",
};

export interface PaletteRef {
	which: keyof typeof MODULES;

	offset: number;
	colors: number[];
}

function locate(buf: Uint8Array, start: number, end: number): number | null {
	const hits: number[] = [];
	for (let base = start; base + 64 <= end; base += 4) {
		if (!(buf[base + 60] === 0xff && buf[base + 61] === 0xff && buf[base + 62] === 0xff)) continue;
		let ok = true;
		const seen = new Set<number>();
		for (let k = 0; k < PALETTE_SIZE; k++) {
			if (buf[base + 4 * k + 3] !== 0) {
				ok = false;
				break;
			}
			seen.add((buf[base + 4 * k]! << 16) | (buf[base + 4 * k + 1]! << 8) | buf[base + 4 * k + 2]!);
		}
		if (ok && seen.size >= 8) hits.push(base);
	}
	return hits.length === 1 ? hits[0]! : null;
}

const readColor = (b: Uint8Array, o: number) => (b[o + 2]! << 16) | (b[o + 1]! << 8) | b[o]!;

export function findPalettes(c: Container): PaletteRef[] {
	const out: PaletteRef[] = [];
	for (const which of Object.keys(MODULES) as (keyof typeof MODULES)[]) {
		const body = moduleBody(c, MODULES[which]);
		if (!body) throw new Error(`module for ${which} not found`);
		const at = locate(c.payload, body.start, body.end);
		if (at === null) throw new Error(`palette not located in ${which}`);
		out.push({
			which,
			offset: at,
			colors: Array.from({ length: PALETTE_SIZE }, (_, k) => readColor(c.payload, at + 4 * k)),
		});
	}
	return out;
}

export function setColor(c: Container, p: PaletteRef, index: number, rgb: number) {
	const o = p.offset + 4 * index;
	c.payload[o] = rgb & 0xff;
	c.payload[o + 1] = (rgb >> 8) & 0xff;
	c.payload[o + 2] = (rgb >> 16) & 0xff;
	c.payload[o + 3] = 0;
	p.colors[index] = rgb;
}

export function setColorEverywhere(c: Container, palettes: PaletteRef[], index: number, rgb: number) {
	for (const p of palettes) setColor(c, p, index, rgb);
}

export type ImageFormat = "png" | "jpeg";

export interface Logo {
	fileGuid: string;

	data: Uint8Array;

	format: ImageFormat;

	nested: boolean;
}

const isPng = (b: Uint8Array, o = 0) =>
	b[o] === 0x89 && b[o + 1] === 0x50 && b[o + 2] === 0x4e && b[o + 3] === 0x47;

const isJpeg = (b: Uint8Array, o = 0) =>
	b[o] === 0xff && b[o + 1] === 0xd8 && b[o + 2] === 0xff && b[o + 3]! >= 0xe0;

const imageFormat = (b: Uint8Array, o = 0): ImageFormat | null =>
	isPng(b, o) ? "png" : isJpeg(b, o) ? "jpeg" : null;

export async function findLogo(c: Container, lzma: Lzma): Promise<Logo | null> {
	for (const file of c.files) {
		for (const sec of walkSections(c.payload, file.body, file.end)) {
			if (sec.type === SEC_RAW) {
				const format = imageFormat(c.payload, sec.body);
				if (format)
					return { fileGuid: file.guid, data: c.payload.subarray(sec.body, sec.end), format, nested: false };
			}

			if (sec.type !== SEC_GUID_DEFINED) continue;
			const inner = await inflateSection(c.payload, sec, lzma);
			if (!inner) continue;
			for (const s2 of walkSections(inner, 0, inner.length)) {
				if (s2.type !== SEC_RAW) continue;
				const format = imageFormat(inner, s2.body);
				if (format)
					return { fileGuid: file.guid, data: inner.subarray(s2.body, s2.end), format, nested: true };
			}
		}
	}
	return null;
}

async function inflateSection(buf: Uint8Array, sec: Section, lzma: Lzma): Promise<Uint8Array | null> {
	if (guidOf(buf, sec.body) !== LZMA_SECTION_GUID) return null;
	const dataOffset = buf[sec.body + 16]! | (buf[sec.body + 17]! << 8);
	try {
		return await lzma.decompress(buf.subarray(sec.start + dataOffset, sec.end));
	} catch {
		return null;
	}
}

export async function replaceLogo(c: Container, image: Uint8Array, lzma: Lzma): Promise<void> {
	const logo = await findLogo(c, lzma);
	if (!logo) throw new Error("no boot logo in this image");

	const file = c.files.find((f) => f.guid === logo.fileGuid);
	if (!file) throw new Error("lost the logo file");

	const outer = walkSections(c.payload, file.body, file.end).find((s) => s.type === SEC_GUID_DEFINED);
	if (!outer) throw new Error("logo is not wrapped the way this tool expects");
	const headerLen = c.payload[outer.body + 16]! | (c.payload[outer.body + 17]! << 8);

	const inner = await inflateSection(c.payload, outer, lzma);
	if (!inner) throw new Error("could not read the logo wrapper");

	const parts: Uint8Array[] = [];
	for (const s of walkSections(inner, 0, inner.length)) {
		const rebuilt = s.type === SEC_RAW ? section(SEC_RAW, image) : inner.slice(s.start, s.end);
		if (parts.length) {
			const pad = (-parts.reduce((n, p) => n + p.length, 0) % 4 + 4) % 4;
			if (pad) parts.push(new Uint8Array(pad));
		}
		parts.push(rebuilt);
	}
	const total = parts.reduce((n, p) => n + p.length, 0);
	const rebuiltInner = new Uint8Array(total);
	let at = 0;
	for (const p of parts) {
		rebuiltInner.set(p, at);
		at += p.length;
	}
	const compressed = await lzma.compress(rebuiltInner);
	const header = c.payload.slice(outer.start, outer.start + headerLen);
	const newSection = new Uint8Array(headerLen + compressed.length);
	newSection.set(header);
	newSection.set(compressed, headerLen);
	writeU24(newSection, 0, newSection.length);

	const ffsHeader = c.payload.slice(file.start, file.body);
	const newFile = new Uint8Array(ffsHeader.length + newSection.length);
	newFile.set(ffsHeader);
	newFile.set(newSection, ffsHeader.length);
	writeU24(newFile, 0x14, newFile.length);
	newFile[0x10] = 0;
	newFile[0x10] = ffsChecksum(newFile);

	spliceFile(c, file, newFile);
}

const section = (type: number, body: Uint8Array) => {
	const out = new Uint8Array(4 + body.length);
	writeU24(out, 0, out.length);
	out[3] = type;
	out.set(body, 4);
	return out;
};

function writeU24(b: Uint8Array, o: number, v: number) {
	b[o] = v & 0xff;
	b[o + 1] = (v >> 8) & 0xff;
	b[o + 2] = (v >> 16) & 0xff;
}

function ffsChecksum(h: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < 16; i++) sum += h[i]!;
	for (let i = 18; i < 23; i++) sum += h[i]!;
	return (0x100 - (sum & 0xff)) & 0xff;
}

function spliceFile(c: Container, file: { start: number; end: number }, replacement: Uint8Array) {
	let fvEnd = c.innerFvStart + volumeLength(c.payload, c.innerFvStart);
	const tailStart = (file.end + 7) & ~7;
	const tail = c.payload.slice(tailStart, fvEnd);

	const at = file.start + replacement.length;
	const padded = (at + 7) & ~7;

	if (padded + tail.length > fvEnd) {
		growVolume(c, padded + tail.length - fvEnd);
		fvEnd = c.innerFvStart + volumeLength(c.payload, c.innerFvStart);
	}

	c.payload.set(replacement, file.start);
	for (let i = at; i < padded; i++) c.payload[i] = 0xff;
	c.payload.set(tail, padded);
	for (let i = padded + tail.length; i < fvEnd; i++) c.payload[i] = 0xff;
}

function growVolume(c: Container, needed: number) {
	const fv = c.innerFvStart;
	const blockSize = u32le(c.payload, fv + 0x3c) || 0x1000;
	const extra = Math.ceil(needed / blockSize) * blockSize;

	const grown = new Uint8Array(c.payload.length + extra);
	grown.set(c.payload);
	grown.fill(0xff, c.payload.length);
	c.payload = grown;

	const newLength = volumeLength(grown, fv) + extra;
	writeU32(grown, fv + 32, newLength);
	writeU32(grown, fv + 36, 0);
	writeU32(grown, fv + 0x38, Math.floor(newLength / blockSize));

	const headerLength = grown[fv + 48]! | (grown[fv + 49]! << 8);
	grown[fv + 50] = 0;
	grown[fv + 51] = 0;
	let sum = 0;
	for (let i = 0; i < headerLength; i += 2) sum = (sum + (grown[fv + i]! | (grown[fv + i + 1]! << 8))) & 0xffff;
	const fix = (0x10000 - sum) & 0xffff;
	grown[fv + 50] = fix & 0xff;
	grown[fv + 51] = (fix >> 8) & 0xff;

	const sec = fv - 4;
	writeU24(grown, sec, u24le(grown, sec) + extra);
}

const u24le = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32le = (b: Uint8Array, o: number) =>
	(b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

function writeU32(b: Uint8Array, o: number, v: number) {
	b[o] = v & 0xff;
	b[o + 1] = (v >>> 8) & 0xff;
	b[o + 2] = (v >>> 16) & 0xff;
	b[o + 3] = (v >>> 24) & 0xff;
}

const volumeLength = (b: Uint8Array, fv: number) =>
	(b[fv + 32]! | (b[fv + 33]! << 8) | (b[fv + 34]! << 16) | (b[fv + 35]! << 24)) >>> 0;

export function imageSize(img: Uint8Array): { width: number; height: number } {
	const be = (o: number) => (((img[o]! << 8) | img[o + 1]!) >>> 0);

	if (isPng(img)) return { width: (be(16) << 16 | be(18)) >>> 0, height: (be(20) << 16 | be(22)) >>> 0 };

	let p = 2;
	while (p + 4 < img.length && img[p] === 0xff) {
		const marker = img[p + 1]!;
		if (marker === 0xda || marker === 0xd9) break;
		if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc)
			return { height: be(p + 5), width: be(p + 7) };
		p += 2 + be(p + 2);
	}
	return { width: 0, height: 0 };
}
