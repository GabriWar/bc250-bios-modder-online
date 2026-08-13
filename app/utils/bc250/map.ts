import type { Container, Lzma } from "./firmware.ts";
import { walkSections } from "./firmware.ts";
import { readTabTable } from "./tabs.ts";

// A readable map of everything the setup menus contain, including the pages no
// menu entry reaches. Those unreachable pages are not junk: one of them holds
// 27 fan-control options, another holds AMD's arbitrary register writes, and
// none of them can be opened on a stock board.

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) =>
	(b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

const FORM = 0x01;
const SUBTITLE = 0x02;
const TEXT = 0x03;
const ONE_OF = 0x05;
const OPTION = 0x09;
const FORMSET = 0x0e;
const REF = 0x0f;
const VARSTORE = 0x24;
const END = 0x29;

/** Opcodes carrying an EFI_IFR_QUESTION_HEADER: prompt, help and id at fixed spots. */
const QUESTIONS: Record<number, string> = {
	0x05: "list",
	0x06: "checkbox",
	0x07: "number",
	0x08: "password",
	0x09: "option",
	0x0a: "text field",
	0x0c: "action",
};

const VALUE_WIDTH: Record<number, number> = { 0: 1, 1: 2, 2: 4, 3: 8 };

export interface MapOption {
	text: string | null;
	value: number;
	isDefault: boolean;
}

export interface MapItem {
	kind: string;
	prompt: string | null;
	help: string | null;
	questionId?: number;
	/** which NVRAM structure the answer is stored in, and where inside it */
	varStoreId?: number;
	varStoreOffset?: number;
	/** width in bytes, for the numeric questions */
	width?: number;
	min?: number;
	max?: number;
	targetForm?: number;
	options?: MapOption[];
}

export interface MapForm {
	id: number;
	title: string | null;
	/** false when no REF anywhere in the image points at this page */
	reachable: boolean;
	/** true when the top bar has an entry for it */
	isTab: boolean;
	items: MapItem[];
}

export interface MapFormset {
	title: string | null;
	guid: string;
	module: string | null;
	varstores: { id: number; size: number; name: string }[];
	forms: MapForm[];
}

/** One node of the navigable tree: a page, and the pages it links to. */
export interface MapNode {
	id: number;
	title: string | null;
	formset: string | null;
	/** true when the top bar has an entry for it */
	isTab: boolean;
	/** true when nothing in the image links to it */
	locked: boolean;
	/** questions on the page itself, not counting the links */
	options: number;
	/** everything on it, including the read-only rows: a page can be full of
	    useful information and hold a single answerable question */
	rows: number;
	/** everything on the page, in order, for the detail panel */
	items: MapItem[];
	varstores: { id: number; size: number; name: string }[];
	children: MapNode[];
}

export interface BiosMap {
	/** the same pages arranged by what links to what */
	tree: MapNode[];
	formsets: MapFormset[];
	/** pages nothing links to, worth surfacing because they hold real options */
	locked: { formset: string | null; id: number; title: string | null; items: number }[];
	tabs: number[];
}

/** Merges every string package in a module; reading only the first yields "str#10". */
function collectStrings(d: Uint8Array, from: number, to: number): Map<number, string> {
	const all = new Map<number, string>();
	for (let p = from; p + 8 < to; p++) {
		const length = u32(d, p) & 0xffffff;
		const type = (u32(d, p) >>> 24) & 0xff;
		if (type !== 0x04 || length < 8 || p + length > to) continue;
		const headerSize = u32(d, p + 4);
		if (headerSize < 8 || headerSize > length) continue;
		let id = 1;
		let q = p + headerSize;
		let produced = 0;
		while (q < p + length) {
			const block = d[q]!;
			if (block === 0x00) break;
			if (block === 0x14) {
				let s = "";
				let r = q + 1;
				while (r + 1 < p + length && u16(d, r)) {
					s += String.fromCharCode(u16(d, r));
					r += 2;
				}
				if (!all.has(id)) all.set(id, s);
				id++;
				q = r + 2;
				produced++;
			} else if (block === 0x10) {
				let r = q + 1;
				while (r < p + length && d[r]) r++;
				q = r + 1;
			} else if (block === 0x30) q += 2;
			else if (block === 0x31) q += 3;
			else if (block === 0x40) q += 1;
			else break;
		}
		if (produced > 3) p += length - 1;
	}
	return all;
}

function guidAt(b: Uint8Array, o: number): string {
	const h = (n: number, w: number) => n.toString(16).padStart(w, "0");
	const p2 = (i: number) => h(b[o + i]!, 2);
	return (
		`${h(u32(b, o), 8)}-${h(u16(b, o + 4), 4)}-${h(u16(b, o + 6), 4)}-` +
		`${p2(8)}${p2(9)}-${p2(10)}${p2(11)}${p2(12)}${p2(13)}${p2(14)}${p2(15)}`
	);
}

/** Builds the full menu map, resolving every string. */
export async function buildMap(c: Container, lzma: Lzma): Promise<BiosMap> {
	const d = c.payload;

	const owners: { name: string | null; from: number; to: number }[] = [];
	for (const f of c.files) {
		let name: string | null = null;
		for (const s of walkSections(d, f.body, f.end)) {
			if (s.type === 0x15) {
				let n = "";
				for (let i = s.body; i + 1 < s.end; i += 2) {
					const ch = u16(d, i);
					if (!ch) break;
					n += String.fromCharCode(ch);
				}
				name = n || null;
			}
		}
		owners.push({ name, from: f.body, to: f.end });
	}
	const ownerOf = (at: number) => owners.find((o) => at >= o.from && at < o.to) ?? null;

	const table = await readTabTable(c, lzma);
	const tabs = table ? table.formIds.slice(0, table.read).filter(Boolean) : [];

	const formsets: MapFormset[] = [];
	const refTargets = new Set<number>();

	for (let p = 0; p + 32 < d.length; p++) {
		if (d[p] !== FORMSET) continue;
		const len = d[p + 1]! & 0x7f;
		if ((d[p + 1]! & 0x80) === 0 || len < 24) continue;
		const classes = d[p + 22]!;
		if (classes < 1 || classes > 4 || len !== 23 + classes * 16) continue;

		const owner = ownerOf(p);
		const strings = owner ? collectStrings(d, owner.from, owner.to) : new Map<number, string>();
		const fs: MapFormset = {
			title: strings.get(u16(d, p + 18)) ?? null,
			guid: guidAt(d, p + 2),
			module: owner?.name ?? null,
			varstores: [],
			forms: [],
		};

		let q = p + len;
		let depth = 1;
		let form: MapForm | null = null;
		let guard = 0;
		while (q + 2 <= d.length && depth > 0 && guard++ < 400000) {
			const op = d[q]!;
			const olen = d[q + 1]! & 0x7f;
			const scope = (d[q + 1]! & 0x80) !== 0;
			if (olen < 2) break;

			if (op === FORM && olen >= 6) {
				form = {
					id: u16(d, q + 2),
					title: strings.get(u16(d, q + 4)) ?? null,
					reachable: false,
					isTab: false,
					items: [],
				};
				fs.forms.push(form);
			} else if (op === VARSTORE && olen >= 23) {
				let name = "";
				for (let r = q + 22; r < q + olen && d[r]; r++) name += String.fromCharCode(d[r]!);
				fs.varstores.push({ id: u16(d, q + 18), size: u16(d, q + 20), name });
			} else if (op === REF && olen >= 15) {
				refTargets.add(u16(d, q + 13));
				form?.items.push({
					kind: "link",
					prompt: strings.get(u16(d, q + 2)) ?? null,
					help: strings.get(u16(d, q + 4)) ?? null,
					targetForm: u16(d, q + 13),
				});
			} else if (op === OPTION && olen >= 6) {
				// Attach to the question above: a repurposed option keeps its stock
				// wording while the values underneath say something else entirely.
				const last = form?.items[form.items.length - 1];
				const type = d[q + 5]!;
				const width = VALUE_WIDTH[type] ?? 1;
				let value = 0;
				for (let i = width - 1; i >= 0; i--) value = value * 256 + (d[q + 6 + i] ?? 0);
				if (last) {
					(last.options ??= []).push({
						text: strings.get(u16(d, q + 2)) ?? null,
						value,
						isDefault: (d[q + 4]! & 0x10) !== 0,
					});
				}
			} else if (QUESTIONS[op] && olen >= 12) {
				const item: MapItem = {
					kind: QUESTIONS[op]!,
					prompt: strings.get(u16(d, q + 2)) ?? null,
					help: strings.get(u16(d, q + 4)) ?? null,
					questionId: u16(d, q + 6),
					varStoreId: u16(d, q + 8),
					varStoreOffset: u16(d, q + 10),
				};
				// A numeric carries its range right after the flags byte, in the
				// width the flags select. Worth surfacing: it is the difference
				// between "type a number" and "type a number between these".
				if (op === 0x07 && olen >= 14) {
					const width = VALUE_WIDTH[d[q + 13]! & 3] ?? 1;
					const read = (at: number) => {
						let v = 0;
						for (let i = width - 1; i >= 0; i--) v = v * 256 + (d[at + i] ?? 0);
						return v;
					};
					item.width = width;
					item.min = read(q + 14);
					item.max = read(q + 14 + width);
				}
				form?.items.push(item);
			} else if ((op === SUBTITLE || op === TEXT) && olen >= 6) {
				form?.items.push({
					kind: op === SUBTITLE ? "heading" : "info",
					prompt: strings.get(u16(d, q + 2)) ?? null,
					help: strings.get(u16(d, q + 4)) ?? null,
				});
			}

			if (scope) depth++;
			if (op === END) depth--;
			q += olen;
		}

		formsets.push(fs);
		p = q - 1;
	}

	const locked: BiosMap["locked"] = [];
	for (const fs of formsets) {
		for (const f of fs.forms) {
			f.reachable = refTargets.has(f.id);
			f.isTab = tabs.includes(f.id);
			if (!f.reachable && !f.isTab && f.items.length) {
				locked.push({ formset: fs.title, id: f.id, title: f.title, items: f.items.length });
			}
		}
	}

	// Arrange the pages by what links to what. A page can be linked from more
	// than one place, so the walk carries the ancestors it came through and
	// stops rather than looping.
	const byId = new Map<number, { form: MapForm; formset: MapFormset }>();
	for (const fs of formsets) for (const f of fs.forms) byId.set(f.id, { form: f, formset: fs });

	const node = (id: number, seen: Set<number>): MapNode | null => {
		const hit = byId.get(id);
		if (!hit || seen.has(id)) return null;
		const next = new Set(seen).add(id);
		const links = hit.form.items.filter((i) => i.kind === "link" && i.targetForm !== undefined);
		return {
			id,
			title: hit.form.title,
			formset: hit.formset.title,
			isTab: hit.form.isTab,
			locked: !hit.form.reachable && !hit.form.isTab,
			options: hit.form.items.filter((i) => i.questionId !== undefined).length,
			rows: hit.form.items.filter((i) => i.kind !== "link").length,
			items: hit.form.items,
			varstores: hit.formset.varstores,
			children: links
				.map((i) => node(i.targetForm!, next))
				.filter((n): n is MapNode => n !== null),
		};
	};

	// Roots are the tabs plus anything nothing links to, so a locked page shows
	// up rather than vanishing for want of a parent.
	const rootIds = new Set<number>(tabs);
	for (const fs of formsets)
		for (const f of fs.forms) if (!f.reachable && !f.isTab) rootIds.add(f.id);
	const tree = [...rootIds]
		.map((id) => node(id, new Set()))
		.filter((n): n is MapNode => n !== null);

	return { tree, formsets, locked, tabs };
}
