import {
	openContainer,
	sealContainer,
	measureBudget,
	type Container,
	type Budget,
	type Lzma,
} from "~/utils/bc250/firmware.ts";
import {
	findPalettes,
	findLogo,
	setColor,
	STOCK,
	replaceLogo,
	imageSize,
	setColorEverywhere,
	type PaletteRef,
	type ImageFormat,
} from "~/utils/bc250/palette.ts";
import { readTabTable, unlockSocDebugTab } from "~/utils/bc250/tabs.ts";
import { type BiosMap, buildMap } from "~/utils/bc250/map.ts";
import { type Check, verifyImage } from "~/utils/bc250/verify.ts";
import { findUmaQuestion, makeUmaTypable, UMA_MAX_MB } from "~/utils/bc250/uma.ts";

export interface RomInfo {
	revision: string;
	fileCount: number;
	budget: Budget;
	palettes: PaletteRef[];
	logo: { url: string; width: number; height: number; bytes: number; format: ImageFormat } | null;
	/** null when this build does not carry the carveout question where we look */
	uma: { typable: boolean; max: number } | null;
	tabs: { read: number; canUnlock: boolean; reason?: string } | null;
}

// Anything that goes wrong reaches both places: the panel the user is looking
// at, and the console, where the stack survives for whoever gets sent the bug.
function report(where: string, e: unknown): string {
	console.error(`[bc250] ${where}`, e);
	return e instanceof Error ? e.message : String(e);
}

let codec: Lzma | null = null;

const paint = () =>
	new Promise<void>((r) => (typeof requestAnimationFrame === "function"
		? requestAnimationFrame(() => setTimeout(r, 0))
		: setTimeout(r, 0)));

async function getCodec(): Promise<Lzma> {
	if (codec) return codec;
	const w = await import("lzma-wasm");
	await w.initWasm();
	codec = {
		async decompress(d) {
			const o = w.decompress(d);
			return o instanceof Uint8Array ? o : new Uint8Array(o);
		},
		async compress(d) {
			const o = w.compress(d, { format: "alone" });
			return o instanceof Uint8Array ? o : new Uint8Array(o);
		},
	};
	return codec;
}

function detectRevision(payload: Uint8Array): string {
	const text = new TextDecoder("latin1").decode(payload);
	return text.match(/\bP\d\.\d\d\b/)?.[0] ?? "unknown";
}

export function useBc250Bios() {
	const busy = ref(false);
	const status = ref("");
	const progress = ref(0);
	const error = ref("");
	const info = ref<RomInfo | null>(null);
	const checks = ref<Check[]>([]);
	const biosMap = ref<BiosMap | null>(null);

	let container: Container | null = null;
	let original: Uint8Array | null = null;

	async function load(file: File) {
		busy.value = true;
		error.value = "";
		info.value = null;
		checks.value = [];
		biosMap.value = null;
		progress.value = 0;
		try {
			status.value = "reading";
			await step(0.1);
			const rom = new Uint8Array(await file.arrayBuffer());
			original = rom;

			status.value = "decompressing";
			await step(0.35);
			const lzma = await getCodec();
			container = await openContainer(rom, lzma);

			status.value = "reading palettes";
			await step(0.75);
			const palettes = findPalettes(container);
			const logoData = await findLogo(container, lzma);

			let logo: RomInfo["logo"] = null;
			if (logoData) {
				const { width, height } = imageSize(logoData.data);
				const copy = new Uint8Array(logoData.data);
				logo = {
					url: URL.createObjectURL(new Blob([copy], { type: `image/${logoData.format}` })),
					width,
					height,
					bytes: logoData.data.length,
					format: logoData.format,
				};
			}

			const uma = findUmaQuestion(container);
			// Reading the tab table means decompressing AMITSE, a second LZMA layer.
			// Worth it at load time so the option can say up front whether this
			// image can take the patch at all.
			const tabs = await readTabTable(container, lzma);
			info.value = {
				revision: detectRevision(container.payload),
				uma: uma ? { typable: uma.typable, max: uma.max } : null,
				tabs: tabs ? { read: tabs.read, canUnlock: tabs.canUnlock, reason: tabs.reason } : null,
				fileCount: container.files.length,
				budget: measureBudget(container),
				palettes,
				logo,
			};
			status.value = "";
			progress.value = 0;
		} catch (e) {
			error.value = report(`reading ${file.name}`, e);
			container = null;
		} finally {
			busy.value = false;
		}
	}

	async function build(
		edits: Map<number, number>,
		restored: Set<number>,
		logo?: Uint8Array | null,
		typableUma = false,
		socDebugTab = false,
	): Promise<Blob> {
		if (!container || !original) throw new Error("no ROM loaded");
		busy.value = true;
		try {
			const lzma = await getCodec();

			status.value = "patching";
			progress.value = 0;
			await step(0.1);
			const palettes = findPalettes(container);
			// The two factory tables are not the same: they part company at 6 and
			// from 8 to 14. Restoring an index has to put each table back to its
			// own value, while a colour the user picked goes to both.
			for (const index of restored)
				for (const p of palettes) setColor(container, p, index, STOCK[p.which][index] ?? 0);
			for (const [index, rgb] of edits) setColorEverywhere(container, palettes, index, rgb);

			if (typableUma) makeUmaTypable(container);

			if (socDebugTab) {
				status.value = "unlocking the extra tab";
				await step(0.2);
				await unlockSocDebugTab(container, lzma);
			}

			if (logo) await replaceLogo(container, logo, lzma);

			status.value = "recompressing";
			await step(0.3);
			const out = await sealContainer(container, lzma);

			// Reported step by step. Reopening the image is the slowest thing
			// here and it blocks the tab, so a single 75% tick is indistinguishable
			// from a hang to anyone watching the bar.
			// Verification reports, it does not veto. A failing check is something
			// to read before flashing, not a reason to withhold the file the user
			// asked for -- and a thrown error used to mean no download at all.
			status.value = "verifying";
			await step(0.8);
			const check = await openContainer(out, lzma);
			const found = await verifyImage(
				check,
				lzma,
				{ size: original.length, files: container.files.length },
				out.length,
			);

			await step(0.9);
			for (const p of findPalettes(check)) {
				for (const index of restored) {
					const want = STOCK[p.which][index] ?? 0;
					found.push({
						name: `${p.which} ${index} back to factory`,
						ok: p.colors[index] === want,
						detail: `#${(p.colors[index] ?? 0).toString(16).padStart(6, "0")}`,
						severe: true,
					});
				}
				for (const [index, rgb] of edits) {
					found.push({
						name: `${p.which} ${index} repainted`,
						ok: p.colors[index] === rgb,
						detail: `#${(p.colors[index] ?? 0).toString(16).padStart(6, "0")}`,
						severe: true,
					});
				}
			}

			if (logo) {
				const back = await findLogo(check, lzma);
				found.push({
					name: "boot logo reads back",
					ok: !!back && back.data.length === logo.length && back.data.every((v, i) => v === logo[i]),
					detail: `${back?.data.length ?? 0} bytes`,
					severe: true,
				});
			}

			if (typableUma) {
				const back = findUmaQuestion(check);
				found.push({
					name: "carveout is typable",
					ok: !!back?.typable && back.max === UMA_MAX_MB,
					detail: back ? `max ${back.max} MB` : "question not found",
					severe: true,
				});
			}

			if (socDebugTab) {
				const back = await readTabTable(check, lzma);
				found.push({
					name: "eighth tab present",
					ok: back?.read === 8 && back.formIds[7] === 28682,
					detail: back ? `${back.read} tabs, eighth = form ${back.formIds[7]}` : "table not read",
					severe: true,
				});
			}

			checks.value = found;

			status.value = "";
			progress.value = 1;
			return new Blob([new Uint8Array(out)], { type: "application/octet-stream" });
		} catch (e) {
			report("building the image", e);
			throw e;
		} finally {
			busy.value = false;
		}
	}

	async function step(to: number) {
		progress.value = to;
		await paint();
	}

	/** Runs the same report over the loaded ROM without building anything. */
	async function inspect(): Promise<Check[]> {
		if (!container || !original) throw new Error("no ROM loaded");
		busy.value = true;
		try {
			status.value = "checking";
			progress.value = 0.5;
			const lzma = await getCodec();
			const found = await verifyImage(
				container,
				lzma,
				{ size: original.length, files: container.files.length },
				original.length,
			);
			checks.value = found;
			return found;
		} catch (e) {
			report("checking the image", e);
			throw e;
		} finally {
			status.value = "";
			progress.value = 0;
			busy.value = false;
		}
	}

	/** Parses every menu, option and description, including the locked pages. */
	async function mapMenus(): Promise<BiosMap> {
		if (!container) throw new Error("no ROM loaded");
		busy.value = true;
		try {
			status.value = "reading the menus";
			progress.value = 0.5;
			const lzma = await getCodec();
			const built = await buildMap(container, lzma);
			biosMap.value = built;
			return built;
		} catch (e) {
			report("reading the menus", e);
			throw e;
		} finally {
			status.value = "";
			progress.value = 0;
			busy.value = false;
		}
	}

	return {
		busy,
		status,
		error,
		info,
		progress,
		checks,
		biosMap,
		load,
		build,
		inspect,
		mapMenus,
	};
}
