import type { Container, Lzma } from "./firmware.ts";
import { walkSections } from "./firmware.ts";

// Everything here comes from something that actually went wrong on a board.
// A check that never fired on a real failure is decoration; these did.

export interface Check {
	name: string;
	ok: boolean;
	detail: string;
	/** false when a failure is cosmetic rather than a reason not to flash */
	severe: boolean;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) =>
	(b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

const FORM = 0x01;
const FORMSET = 0x0e;
const REF = 0x0f;
const VARSTORE = 0x24;
/** EFI_IFR_END is 0x29. Decrementing on 0x1d invents hundreds of phantom errors. */
const END = 0x29;
const QUESTION_OPS = new Set([0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0c]);

function findFormsets(d: Uint8Array): number[] {
	const found: number[] = [];
	for (let p = 0; p + 32 < d.length; p++) {
		if (d[p] !== FORMSET) continue;
		const len = d[p + 1]! & 0x7f;
		if ((d[p + 1]! & 0x80) === 0 || len < 24) continue;
		const classes = d[p + 22]!;
		if (classes < 1 || classes > 4 || len !== 23 + classes * 16) continue;
		found.push(p);
	}
	return found;
}

/**
 * Runs every structural check over a sealed image.
 *
 * Nothing here throws. A failing check is information, not a veto -- the caller
 * decides what to do with it.
 */
export async function verifyImage(
	c: Container,
	lzma: Lzma,
	expect: { size: number; files: number },
	actualSize: number,
): Promise<Check[]> {
	const out: Check[] = [];
	const add = (name: string, ok: boolean, detail = "", severe = true) =>
		out.push({ name, ok, detail, severe });

	add(
		"image size unchanged",
		actualSize === expect.size,
		`${actualSize.toLocaleString("en-US")} bytes`,
	);
	add(
		"file count unchanged",
		c.files.length === expect.files,
		`${c.files.length} files`,
	);

	const d = c.payload;
	const formsets = findFormsets(d);
	add("setup formsets found", formsets.length > 0, `${formsets.length}`);

	// Scope balance. The browser walks these scopes; an unbalanced one is how a
	// rewritten page takes the whole setup UI down with it.
	let unbalanced = 0;
	let oddScope = 0;
	const profile = new Map<number, { scoped: number; plain: number; lens: Set<number> }>();
	for (const fs of formsets) {
		let p = fs + (d[fs + 1]! & 0x7f);
		let depth = 1;
		let guard = 0;
		while (p + 2 <= d.length && depth > 0 && guard++ < 400000) {
			const op = d[p]!;
			const len = d[p + 1]! & 0x7f;
			const scope = (d[p + 1]! & 0x80) !== 0;
			if (len < 2) {
				unbalanced++;
				break;
			}
			const seen = profile.get(op) ?? { scoped: 0, plain: 0, lens: new Set<number>() };
			scope ? seen.scoped++ : seen.plain++;
			seen.lens.add(len);
			profile.set(op, seen);
			if (scope) depth++;
			if (op === END) depth--;
			p += len;
		}
		if (depth !== 0) unbalanced++;
	}
	add("formset scopes balanced", unbalanced === 0, `${formsets.length} formsets`);

	// An opcode written with a scope bit it never normally carries produces a
	// form the browser cannot walk. Profile from the image rather than from a
	// hand-written table -- a table written from memory is what let a broken
	// image through with full marks.
	//
	// Only judge opcodes seen at a single length. A linear walk cannot tell an
	// opcode from a data byte that happens to sit where one was expected, and it
	// does drift into data: this firmware yields "TRUE" and "FALSE" at lengths 6,
	// 8 and 10, when the spec fixes both at 2. Several lengths for one opcode
	// means the walk is unreliable there, and an unreliable reading is not
	// evidence of anything. Judging them anyway warned on the image that runs
	// fine on the board, every single time.
	const odd: string[] = [];
	for (const [op, p] of profile) {
		const total = p.scoped + p.plain;
		if (total < 8 || p.lens.size !== 1) continue;
		const minority = Math.min(p.scoped, p.plain);
		if (minority > 0 && minority / total < 0.1) {
			odd.push(`0x${op.toString(16)} (${minority}/${total})`);
			oddScope += minority;
		}
	}
	add(
		"opcode scope bits consistent",
		odd.length === 0,
		odd.slice(0, 3).join(", "),
		false,
	);

	// A duplicate question id inside one varstore is silent in the image and
	// kills the page at runtime.
	let dupes = 0;
	for (const fs of formsets) {
		const seen = new Set<string>();
		let p = fs + (d[fs + 1]! & 0x7f);
		let depth = 1;
		let guard = 0;
		while (p + 2 <= d.length && depth > 0 && guard++ < 400000) {
			const op = d[p]!;
			const len = d[p + 1]! & 0x7f;
			if (len < 2) break;
			if (QUESTION_OPS.has(op) && len >= 12) {
				const key = `${u16(d, p + 8)}:${u16(d, p + 6)}`;
				if (u16(d, p + 6) !== 0) {
					if (seen.has(key)) dupes++;
					else seen.add(key);
				}
			}
			if ((d[p + 1]! & 0x80) !== 0) depth++;
			if (op === END) depth--;
			p += len;
		}
	}
	add("question ids unique", dupes === 0, dupes ? `${dupes} duplicated` : "");

	// The AMITSE page table stores, for every item on every page, the offset of
	// its opcode in the IFR. Rewriting a page body without rewriting those
	// offsets leaves them pointing into the middle of the new opcodes, and the
	// setup engine walks straight into it. That is a black screen, and it is the
	// one failure this tool has actually caused.
	const spf = await findSpf(c, lzma);
	if (spf) {
		const { blob, base } = spf;
		const itemBase = u32(blob, 0x30);
		let items = 0;
		let bad = 0;
		let p = 0x60;
		while (p + 0x18 < blob.length) {
			if (u16(blob, p) === 1 && u32(blob, p + 0x10) === 0x3a) {
				const count = u32(blob, p + 0x14);
				if (count >= 1 && count < 4000 && p + 0x18 + count * 4 <= blob.length) {
					for (let i = 0; i < count; i++) {
						const ptr = u32(blob, p + 0x18 + i * 4);
						const rec = itemBase + ptr;
						if (rec + 0x2c > blob.length) continue;
						const target = base + u32(blob, rec + 0x28);
						items++;
						const op = d[target];
						const len = d[target + 1]! & 0x7f;
						if (op === undefined || len < 2 || len > 0x60) bad++;
					}
					p = p + 0x18 + count * 4;
					continue;
				}
			}
			p += 2;
		}
		// A factory image already carries two of these, and the image running on
		// the board carries one, so zero is the wrong bar -- it would fire on a
		// ROM nobody touched. The images that actually black-screened carried five
		// and six. Flag the excess, not the presence.
		const FACTORY_SLACK = 2;
		add(
			"page table offsets valid",
			bad <= FACTORY_SLACK,
			`${items} items, ${bad} dangling`,
		);
	}

	// A REF that points at a form id nobody defines is a dead menu entry. Resolve
	// across every formset: a REF may legitimately target another one, and
	// checking inside a single formset flags three the factory image ships with.
	const formIds = new Set<number>();
	for (const fs of formsets) {
		let p = fs + (d[fs + 1]! & 0x7f);
		let depth = 1;
		let guard = 0;
		while (p + 2 <= d.length && depth > 0 && guard++ < 400000) {
			const op = d[p]!;
			const len = d[p + 1]! & 0x7f;
			if (len < 2) break;
			if (op === FORM && len >= 6) formIds.add(u16(d, p + 2));
			if ((d[p + 1]! & 0x80) !== 0) depth++;
			if (op === END) depth--;
			p += len;
		}
	}
	let dangling = 0;
	for (const fs of formsets) {
		let p = fs + (d[fs + 1]! & 0x7f);
		let depth = 1;
		let guard = 0;
		while (p + 2 <= d.length && depth > 0 && guard++ < 400000) {
			const op = d[p]!;
			const len = d[p + 1]! & 0x7f;
			if (len < 2) break;
			if (op === REF && len >= 15) {
				const t = u16(d, p + 13);
				if (t && !formIds.has(t)) dangling++;
			}
			if ((d[p + 1]! & 0x80) !== 0) depth++;
			if (op === END) depth--;
			p += len;
		}
	}
	add("menu links resolve", dangling === 0, `${formIds.size} pages`);

	return out;
}

/**
 * The AMITSE page table blob, and where the IFR its offsets refer to begins.
 *
 * The blob sits inside a GUID-defined LZMA section, a second layer of
 * compression. Searching only the top level finds nothing -- the same mistake
 * that once made this firmware look like 187 files with no AMITSE in them.
 */
async function findSpf(
	c: Container,
	lzma: Lzma,
): Promise<{ blob: Uint8Array; base: number } | null> {
	const d = c.payload;
	const fsAt = findSetupFormset(d);
	if (fsAt === null) return null;

	for (const f of c.files) {
		for (const s of walkSections(d, f.body, f.end)) {
			if (s.type !== 0x02) continue;
			const header = s.body - 4;
			const start = header + u16(d, header + 20);
			if (start >= s.end) continue;
			let inner: Uint8Array;
			try {
				inner = await lzma.decompress(d.slice(start, s.end));
			} catch {
				continue;
			}
			for (let q = 0; q + 8 < inner.length; q++) {
				const size = inner[q]! | (inner[q + 1]! << 8) | (inner[q + 2]! << 16);
				const type = inner[q + 3]!;
				if (type !== 0x18 && type !== 0x19) continue;
				if (size < 8 || q + size > inner.length) continue;
				const body = q + (type === 0x18 ? 20 : 4);
				if (u32(inner, body) === 0x46505324) {
					return { blob: inner.slice(body, q + size), base: fsAt - 4 };
				}
			}
		}
	}

	// Fall back to the uncompressed layer, for images that keep it in the open.
	for (const f of c.files) {
		for (const s of walkSections(d, f.body, f.end)) {
			if (s.type !== 0x18 && s.type !== 0x19) continue;
			if (s.end - s.body < 8) continue;
			if (u32(d, s.body) !== 0x46505324) continue; // "$SPF"
			return { blob: d.slice(s.body, s.end), base: fsAt - 4 };
		}
	}
	return null;
}

function findSetupFormset(d: Uint8Array): number | null {
	for (const p of findFormsets(d)) {
		// The setup formset owns the varstore named "Setup".
		let q = p + (d[p + 1]! & 0x7f);
		let depth = 1;
		let guard = 0;
		while (q + 2 <= d.length && depth > 0 && guard++ < 400000) {
			const op = d[q]!;
			const len = d[q + 1]! & 0x7f;
			if (len < 2) break;
			if (op === VARSTORE && len >= 27) {
				let name = "";
				for (let r = q + 22; r < q + len && d[r]; r++) name += String.fromCharCode(d[r]!);
				if (name === "Setup") return p;
			}
			if ((d[q + 1]! & 0x80) !== 0) depth++;
			if (op === END) depth--;
			q += len;
		}
	}
	return null;
}
