import type { Container } from "./firmware.ts";

// The UMA carveout question, identified by the three ids that follow its
// header rather than by position: question 0x0149, varstore 0x5000, offset
// 0x025F. Anything else in the image that happens to look like an IFR opcode
// will not carry this triple.
const QID = 0x0149;
const VARSTORE = 0x5000;
const VAROFFSET = 0x025f;

const ONE_OF = 0x05;
const NUMERIC = 0x07;

/** 15 GB. The board has 16, and the last gigabyte has to stay for the OS. */
export const UMA_MAX_MB = 15360;

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) =>
	(b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

export interface UmaQuestion {
	/** offset of the opcode inside the payload */
	offset: number;
	/** 0x05 while it is a dropdown, 0x07 once it takes a typed value */
	opcode: number;
	min: number;
	max: number;
	step: number;
	typable: boolean;
}

/**
 * Finds the carveout question, or null.
 *
 * Refuses on more than one match. A second hit would mean the triple is not
 * unique in this build, and picking either one would be a guess about which
 * question the user is about to rewrite.
 */
export function findUmaQuestion(c: Container): UmaQuestion | null {
	const d = c.payload;
	let at = -1;
	for (let i = 0; i + 6 <= d.length; i++) {
		if (u16(d, i) !== QID || u16(d, i + 2) !== VARSTORE || u16(d, i + 4) !== VAROFFSET) continue;
		if (at !== -1) return null;
		at = i;
	}
	if (at === -1) return null;

	const offset = at - 6;
	if (offset < 0) return null;
	const opcode = d[offset]!;
	if (opcode !== ONE_OF && opcode !== NUMERIC) return null;

	return {
		offset,
		opcode,
		min: u32(d, offset + 14),
		max: u32(d, offset + 18),
		step: u32(d, offset + 22),
		typable: opcode === NUMERIC,
	};
}

/**
 * Turns the dropdown into a field you can type a number into.
 *
 * EFI_IFR_ONE_OF and EFI_IFR_NUMERIC have byte-identical layouts, so the
 * conversion is the opcode alone. Everything a Numeric needs is already set in
 * this build: flags 0x12 is an unsigned 32-bit decimal, and a step of 0 means
 * type the value rather than walk it with +/-.
 *
 * The ceiling comes down from 0xFFFFFFFF at the same time. Four billion MB is
 * not a carveout anyone meant to ask for, and a slip with the old maximum goes
 * straight into memory init.
 */
export function makeUmaTypable(c: Container, maxMb = UMA_MAX_MB): void {
	const q = findUmaQuestion(c);
	if (!q) throw new Error("the UMA carveout question is not where this tool expects it in this image");
	if (q.typable) return;

	const d = c.payload;
	if ((d[q.offset + 13]! & 3) !== 2)
		throw new Error("the UMA question is not a 32-bit value in this image, refusing to convert it");

	d[q.offset] = NUMERIC;
	d[q.offset + 18] = maxMb & 0xff;
	d[q.offset + 19] = (maxMb >> 8) & 0xff;
	d[q.offset + 20] = (maxMb >> 16) & 0xff;
	d[q.offset + 21] = (maxMb >> 24) & 0xff;
}
