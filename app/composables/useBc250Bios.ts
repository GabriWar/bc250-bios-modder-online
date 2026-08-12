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

export interface RomInfo {
	revision: string;
	fileCount: number;
	budget: Budget;
	palettes: PaletteRef[];
	logo: { url: string; width: number; height: number; bytes: number; format: ImageFormat } | null;
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

	let container: Container | null = null;
	let original: Uint8Array | null = null;

	async function load(file: File) {
		busy.value = true;
		error.value = "";
		info.value = null;
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

			info.value = {
				revision: detectRevision(container.payload),
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

			if (logo) await replaceLogo(container, logo, lzma);

			status.value = "recompressing";
			await step(0.3);
			const out = await sealContainer(container, lzma);

			// Reported step by step. Reopening the image is the slowest thing
			// here and it blocks the tab, so a single 75% tick is indistinguishable
			// from a hang to anyone watching the bar.
			status.value = "verifying size";
			await step(0.78);
			if (out.length !== original.length)
				throw new Error(`size changed: ${out.length} vs ${original.length}`);

			status.value = "reopening the image";
			await step(0.82);
			const check = await openContainer(out, lzma);

			status.value = "verifying files";
			await step(0.9);
			if (check.files.length !== container.files.length)
				throw new Error(`file count changed: ${check.files.length} vs ${container.files.length}`);

			if (logo) {
				status.value = "verifying logo";
				await step(0.94);
				const back = await findLogo(check, lzma);
				if (!back || back.data.length !== logo.length || !back.data.every((v, i) => v === logo[i]))
					throw new Error("the logo does not read back as written");
			}

			status.value = "verifying colours";
			await step(0.97);
			for (const p of findPalettes(check)) {
				for (const index of restored)
					if (p.colors[index] !== (STOCK[p.which][index] ?? 0))
						throw new Error(
							`${p.which} index ${index} did not go back to factory: reads #${p.colors[index]!.toString(16)}`,
						);
				for (const [index, rgb] of edits)
					if (p.colors[index] !== rgb)
						throw new Error(
							`${p.which} index ${index} reads back #${p.colors[index]!.toString(16)}`,
						);
			}

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

	return { busy, status, error, info, progress, load, build };
}
