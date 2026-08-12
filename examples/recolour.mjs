// Recolour one palette index and optionally swap the boot logo, from the CLI.
//
//   node examples/recolour.mjs in.ROM out.ROM 1 9141ac [logo.png|logo.jpg]
//
// Index 1 is the safe one: menu text and the default dialog background. Both
// palettes get written, otherwise the popups keep the old colour.
import { readFileSync, writeFileSync } from "node:fs";
import * as w from "lzma-wasm";
import { openContainer, sealContainer, measureBudget } from "../src/firmware.ts";
import { findPalettes, setColorEverywhere, findLogo, replaceLogo, imageSize } from "../src/palette.ts";

await w.initWasm();
const lzma = {
	async decompress(d) { const o = w.decompress(d); return o instanceof Uint8Array ? o : new Uint8Array(o); },
	// "alone" is the container EDK2 expects; the xz default would not decode
	async compress(d) { const o = w.compress(d, { format: "alone" }); return o instanceof Uint8Array ? o : new Uint8Array(o); },
};

const [, , src, dst, indexArg, colourArg, logoPath] = process.argv;
if (!src || !dst) {
	console.error("usage: recolour.mjs in.ROM out.ROM [index] [rrggbb] [logo]");
	process.exit(1);
}

const rom = new Uint8Array(readFileSync(src));
const c = await openContainer(rom, lzma);
const budget = measureBudget(c);
console.log(`files ${c.files.length}, compressed ${budget.compressed}B, slack ${budget.compressedSlack}B, volume free ${budget.volumeSlack}B`);

if (indexArg && colourArg)
	setColorEverywhere(c, findPalettes(c), Number(indexArg), Number.parseInt(colourArg, 16));

if (logoPath) {
	const before = await findLogo(c, lzma);
	const image = new Uint8Array(readFileSync(logoPath));
	// The firmware only carries the decoder for the format it shipped with.
	if (before && !logoPath.toLowerCase().endsWith(before.format === "jpeg" ? ".jpg" : ".png"))
		console.warn(`warning: this ROM ships ${before.format}, check your file matches`);
	await replaceLogo(c, image, lzma);
}

const out = await sealContainer(c, lzma);

// Never hand back an image that was not reopened and checked.
if (out.length !== rom.length) throw new Error(`size changed: ${out.length} vs ${rom.length}`);
const check = await openContainer(out, lzma);
if (check.files.length !== c.files.length) throw new Error("file count changed");
if (indexArg && colourArg)
	for (const p of findPalettes(check))
		if (p.colors[Number(indexArg)] !== Number.parseInt(colourArg, 16))
			throw new Error(`${p.which} index ${indexArg} did not take`);
const logo = await findLogo(check, lzma);
if (logo) console.log(`logo ${logo.format} ${imageSize(logo.data).width}x${imageSize(logo.data).height} ${logo.data.length}B`);

writeFileSync(dst, out);
console.log(`wrote ${dst}`);
