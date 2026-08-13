import type { Container, Lzma } from "./firmware.ts";
import { walkSections } from "./firmware.ts";

// The top bar of the setup utility is not built from the HII data. AMITSE keeps
// a fixed table of {formset GUID, form id} entries in its .data, and a loop with
// a hard-coded byte limit decides how many of them are read. Entries past that
// limit sit in the image and never reach the screen.
//
// Seven hypotheses drawn from the IFR -- one tab per formset, root REFs, orphan
// forms, a shared marker, a class opcode, SUPPRESS_IF, an incoming REF -- were
// each falsified against a flashed board before this table turned up.

/** File GUID of the AMITSE driver, which owns the tab table. */
const AMITSE_GUID = "b1da0adf-4f77-4070-a88e-bffe1c60529a";

/** Entries are 32 bytes: GUID(16), form id(2), padding(6), runtime handle(8). */
const ENTRY = 32;

/** Offset of the table inside the AMITSE image. */
const TABLE = 0x45290;

/** Where the eighth entry goes -- today the first entry of the second table. */
const SLOT = TABLE + 7 * ENTRY;

const CBS_FORMSET = [
	0xe3, 0x35, 0x45, 0xb0, 0x04, 0x30, 0x46, 0x49,
	0x9e, 0xb7, 0x14, 0x94, 0x28, 0x98, 0x30, 0x53,
];

/** "SOC Debug Options", the page that leads to the GRA register writes. */
const SOC_DEBUG_FORM = 28682;

// Growing the first table costs six 32-bit immediates, not two: a second table
// sits immediately behind it and has to move out of the way. Patching only the
// limits makes the two overlap, and nothing new appears.
//
// This is not deduction. Diffing a stock AMITSE against the 8-core one shows
// exactly these six bytes changed, because whoever built that BIOS already went
// from six tabs to seven the same way.
const SITES = [
	{ at: 0x1b45a, from: 0xe0, to: 0x100, what: "first loop limit" },
	{ at: 0x2a6e0, from: 0xe0, to: 0x100, what: "second loop limit" },
	{ at: 0x2a732, from: 0x45370, to: 0x45390, what: "second table base" },
	{ at: 0x2a702, from: 0x45380, to: 0x453a0, what: "second table +0x10" },
	{ at: 0x2a721, from: 0x45388, to: 0x453a8, what: "second table +0x18" },
	{ at: 0x2a776, from: 0x60, to: 0x40, what: "second table limit" },
];

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u24 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16);
const u32 = (b: Uint8Array, o: number) =>
	(b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

const write32 = (b: Uint8Array, o: number, v: number) => {
	b[o] = v & 0xff;
	b[o + 1] = (v >>> 8) & 0xff;
	b[o + 2] = (v >>> 16) & 0xff;
	b[o + 3] = (v >>> 24) & 0xff;
};

interface Nested {
	/** start of the LZMA payload inside c.payload */
	start: number;
	/** one past its end */
	end: number;
	/** the decompressed section stream */
	inner: Uint8Array;
	/** where the PE32 body begins inside `inner` */
	pe: number;
}

/**
 * AMITSE lives in a GUID-defined LZMA section of its own, a second layer of
 * compression inside the already-compressed volume. Tooling that walks only the
 * outer layer does not see this module at all.
 */
async function openAmitse(c: Container, lzma: Lzma): Promise<Nested | null> {
	const file = c.files.find((f) => f.guid === AMITSE_GUID);
	if (!file) return null;

	const section = walkSections(c.payload, file.body, file.end).find((s) => s.type === 0x02);
	if (!section) return null;

	const header = section.body - 4;
	const start = header + u16(c.payload, header + 20);
	const end = section.end;
	if (start >= end) return null;

	let inner: Uint8Array;
	try {
		inner = await lzma.decompress(c.payload.slice(start, end));
	} catch {
		return null;
	}

	let pe: number | null = null;
	for (let p = 0; p + 4 <= inner.length; ) {
		const size = u24(inner, p);
		if (size < 4 || p + size > inner.length) break;
		if (inner[p + 3] === 0x10) pe = p + 4;
		p = (p + size + 3) & ~3;
	}
	if (pe === null) return null;

	return { start, end, inner, pe };
}

export interface TabTable {
	/** how many entries the loop reads today */
	read: number;
	/** form ids in the table, in stored order */
	formIds: number[];
	/** true when the eighth slot is free and every patch site reads as expected */
	canUnlock: boolean;
	/** why not, when canUnlock is false */
	reason?: string;
}

/** Reads the tab table without touching it. */
export async function readTabTable(c: Container, lzma: Lzma): Promise<TabTable | null> {
	const a = await openAmitse(c, lzma);
	if (!a) return null;

	const limit = u32(a.inner, a.pe + SITES[0]!.at);
	const read = Math.floor(limit / ENTRY);
	const formIds = [...Array(9)].map((_, i) => u16(a.inner, a.pe + TABLE + i * ENTRY + 0x10));

	// Say something a reader can act on. A stock image is not broken, it just
	// starts from six tabs, and the six immediates this patch writes are the
	// ones that take a seven-tab layout to eight.
	if (read !== 7) {
		const already = formIds[7] === SOC_DEBUG_FORM;
		return {
			read,
			formIds,
			canUnlock: false,
			reason: already
				? "this image already has the extra tab"
				: `this image has ${read} tabs; the patch is written for the 7-tab layout`,
		};
	}
	for (const s of SITES) {
		if (u32(a.inner, a.pe + s.at) !== s.from) {
			return {
				read,
				formIds,
				canUnlock: false,
				reason: `AMITSE is laid out differently here (${s.what}), so the patch would write to the wrong place`,
			};
		}
	}
	if (u16(a.inner, a.pe + SLOT + 0x10) !== 0) {
		return { read, formIds, canUnlock: false, reason: "the eighth table slot is already in use" };
	}
	return { read, formIds, canUnlock: true };
}

/**
 * Adds "SOC Debug Options" as an eighth tab.
 *
 * Rewrites the AMITSE image in place and pads the recompressed block back to
 * its original length, so the section, the file and the payload all keep the
 * size they had. Nothing outside this one module changes.
 */
export async function unlockSocDebugTab(c: Container, lzma: Lzma): Promise<void> {
	const a = await openAmitse(c, lzma);
	if (!a) throw new Error("AMITSE not found; this image is not the layout the tab patch expects");

	for (const s of SITES) {
		const got = u32(a.inner, a.pe + s.at);
		if (got !== s.from) {
			throw new Error(
				`AMITSE ${s.what} reads 0x${got.toString(16)}, expected 0x${s.from.toString(16)}`,
			);
		}
	}
	if (u16(a.inner, a.pe + SLOT + 0x10) !== 0) {
		throw new Error("the eighth tab slot is already in use");
	}

	const edited = new Uint8Array(a.inner);
	for (const s of SITES) write32(edited, a.pe + s.at, s.to);
	edited.set(CBS_FORMSET, a.pe + SLOT);
	edited[a.pe + SLOT + 0x10] = SOC_DEBUG_FORM & 0xff;
	edited[a.pe + SLOT + 0x11] = SOC_DEBUG_FORM >> 8;

	const room = a.end - a.start;
	const packed = await lzma.compress(edited);
	if (packed.length > room) {
		throw new Error(`recompressed AMITSE is ${packed.length - room} bytes too large`);
	}

	// The decoder stops once it has produced the length recorded in the header,
	// so trailing bytes are ignored. Padding rather than shrinking keeps every
	// size downstream untouched -- but verify it round-trips before trusting it.
	const block = new Uint8Array(room);
	block.set(packed, 0);
	const back = await lzma.decompress(block);
	if (back.length !== edited.length || back.some((v, i) => v !== edited[i])) {
		throw new Error("padded AMITSE does not decompress back to what was written");
	}

	c.payload.set(block, a.start);
}
