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

// Where an image this cannot read should end up, rather than dying silently
// on someone else's machine.
const REPORT = "https://github.com/GabriWar/bc250-bios-modder-online/issues";

export const PALETTE_SIZE = 16;

// Read off a board flashed with one unmistakable colour per index. Several of
// these are not where you would expect: read-only fields are 8 rather than 0,
// and 0 turns up as the POST background and the shadow under a dialog.
export const ROLES: Record<number, string> = {
	0: "section headings; POST and shell background; dialog shadow and selection",
	1: "body text; title and footer bars; dialog background",
	2: "boot manager selection",
	3: "unused",
	4: "driver error messages",
	5: "unused",
	6: "unused",
	7: "screen background; footer text",
	8: "read-only fields and their values",
	9: "POST console messages",
	10: "POST console messages",
	11: "POST console messages",
	12: "POST console messages",
	13: "POST console messages",
	14: "POST console messages",
	15: "editable values; title text; dialog text and border",
};

export interface PaletteRef {
	which: keyof typeof MODULES;

	offset: number;
	colors: number[];
}

const readColor = (b: Uint8Array, o: number) => (b[o + 2]! << 16) | (b[o + 1]! << 8) | b[o]!;

// Bytes that follow each table. Colour edits never reach them, unlike a
// signature keyed on palette content, which stops matching the moment someone
// repaints the index it depended on. Identical across 21 images, AMI and
// MeiMei, stock and already modified.
const TAIL: Record<keyof typeof MODULES, number[]> = {
	screen: [0x41, 0x00, 0x4d, 0x00, 0x49, 0x00, 0x20, 0x00, 0x47, 0x00, 0x72, 0x00],
	popups: [0x00, 0x00, 0x80, 0x00, 0x00, 0x01, 0x00, 0x03, 0x00, 0x20, 0x80, 0x20],
};

// Factory colours, only to break ties on an image whose tail is unrecognised.
const STOCK: Record<keyof typeof MODULES, number[]> = {
	screen: [
		0x000000, 0x000098, 0x009800, 0x009898, 0x980000, 0x980098, 0x804000, 0x989898, 0x101010,
		0x1010ff, 0x10ff10, 0xe0ffff, 0xff1010, 0xff10f0, 0xffff10, 0xffffff,
	],
	popups: [
		0x000000, 0x000098, 0x009800, 0x009898, 0x980000, 0x980098, 0x989800, 0x989898, 0x303030,
		0x0000ff, 0x00ff00, 0x00ffff, 0xff0000, 0xff00ff, 0xffff00, 0xffffff,
	],
};

// Sixteen EFI_GRAPHICS_OUTPUT_BLT_PIXEL: blue, green, red, reserved. The
// reserved byte is what makes the shape checkable, and a real table carries
// real variety, so a run of repeated or blank data cannot pass for one.
// Necessary but nowhere near sufficient: this alone matches 2289 places inside
// the screen module and 5733 inside popups.
function looksLikePalette(buf: Uint8Array, base: number): boolean {
	const seen = new Set<number>();
	for (let k = 0; k < PALETTE_SIZE; k++) {
		if (buf[base + 4 * k + 3] !== 0) return false;
		seen.add((buf[base + 4 * k]! << 16) | (buf[base + 4 * k + 1]! << 8) | buf[base + 4 * k + 2]!);
	}
	return seen.size >= 8;
}

function locate(
	buf: Uint8Array,
	start: number,
	end: number,
	which: keyof typeof MODULES,
): number | null {
	const shaped: number[] = [];
	for (let base = start; base + 64 <= end; base += 4)
		if (looksLikePalette(buf, base)) shaped.push(base);

	// Both signals are required, never either alone. Over 627900 positions in
	// 21 images the tail matched 21 times, once per image, and every one of
	// those also passed the shape check.
	const tail = TAIL[which];
	const anchored = shaped.filter((base) => tail.every((b, i) => buf[base + 64 + i] === b));
	if (anchored.length === 1) return anchored[0]!;

	// Only reached on an image whose tail this does not know. Falls back to how
	// closely a candidate still resembles the factory table, which holds while
	// most indices are untouched and refuses rather than guessing when the
	// winner is not clear.
	const stock = STOCK[which];
	let best = -1;
	let at: number | null = null;
	let ties = 0;
	for (const base of shaped) {
		let score = 0;
		for (let k = 0; k < PALETTE_SIZE; k++) if (readColor(buf, base + 4 * k) === stock[k]) score++;
		if (score > best) {
			best = score;
			at = base;
			ties = 1;
		} else if (score === best) ties++;
	}
	return ties === 1 && best >= 4 ? at : null;
}

export function findPalettes(c: Container): PaletteRef[] {
	const out: PaletteRef[] = [];
	for (const which of Object.keys(MODULES) as (keyof typeof MODULES)[]) {
		const body = moduleBody(c, MODULES[which]);
		if (!body) throw new Error(
				`the ${which} module is missing from this image. if it is a BC-250 BIOS, it is a build this tool ` +
					`does not know yet: please report it at ${REPORT}`,
			);
		const at = locate(c.payload, body.start, body.end, which);
		if (at === null) throw new Error(
				`could not find the ${which} palette. the table is anchored on the bytes that follow it, so a ` +
					`BIOS build laid out differently reads as unknown rather than being guessed at. please report ` +
					`this image at ${REPORT}`,
			);
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
	if (!logo) throw new Error(
		"no boot logo found. this tool reads PNG and JPEG splashes; if yours is neither, report the image at " +
			REPORT,
	);

	const file = c.files.find((f) => f.guid === logo.fileGuid);
	if (!file) throw new Error("lost the logo file");

	const outer = walkSections(c.payload, file.body, file.end).find((s) => s.type === SEC_GUID_DEFINED);
	if (!outer) throw new Error(
		"the logo is not wrapped the way this tool expects, so replacing it would risk the image. report it at " +
			REPORT,
	);
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
