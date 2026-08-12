<script setup lang="ts">
const { t, tm, rt } = useI18n();

useHead({ title: "bc250 bios | gabriwar.xyz" });
useSeoMeta({
	title: "BC-250 BIOS recolour | GabriWar",
	description:
		"Drop an AMD BC-250 BIOS image and repaint it. Runs entirely in the browser; the ROM never leaves your machine.",
	ogTitle: "BC-250 BIOS recolour | GabriWar",
	ogDescription: "Repaint the BC-250 BIOS in your browser.",
	ogUrl: "https://www.gabriwar.xyz/bc250",
});

import { STOCK, ROLES } from "~/utils/bc250/palette.ts";

const { busy, status, error, info, progress, load, build } = useBc250Bios();

const SAFE_INDEX = 1;

const dragging = ref(false);
const filename = ref("");
const downloadUrl = ref("");
const acked = ref(false);
const umaTypable = ref(false);
const selected = ref(SAFE_INDEX);

const edits = ref(new Map<number, number>());
// Indices asked to go back to factory. Kept apart from edits because the two
// tables have different factory values at 6 and 8 to 14, so this cannot be
// expressed as one colour written to both.
const restored = ref(new Set<number>());

const lines = (key: string) => (tm(`bc250.${key}`) as unknown[]).map((l) => rt(l as string));
const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
const kb = (n: number) => (n / 1024).toFixed(1) + "K";

const W = 62;
const top = (title: string) => {
	const s = ` ${title} `;
	return "╔══" + s + "═".repeat(Math.max(0, W - 4 - s.length)) + "╗";
};
const bot = () => "╚" + "═".repeat(W - 2) + "╝";
const pad = (s: string, w = W - 4) => (s.length >= w ? s.slice(0, w) : s + " ".repeat(w - s.length));
const pair = (l: string, r: string, w = W - 4) => {
	const gap = w - l.length - r.length;
	return gap < 1 ? pad(l + r, w) : pad(l + " ".repeat(gap) + r, w);
};

// The swatch is the picker: clicking a colour opens it in place, so there is
// no separate field to scroll down to and no index to keep in your head.
function paint(index: number, value: string) {
	selected.value = index;
	const next = new Map(edits.value);
	next.set(index, Number.parseInt(value.slice(1), 16));
	edits.value = next;
	const keep = new Set(restored.value);
	keep.delete(index);
	restored.value = keep;
	downloadUrl.value = "";
}

// Reverting one index at a time, because the interesting mistakes are single
// colours: you find the body unreadable and want that one back, not the five
// others you were happy with.
// Order and emphasis follow what the board itself paints. 2 sits with the rest
// even though it is not idle: it tints the boot manager's selected row, which
// is somebody else's program rather than this firmware.
const USED = [0, 1, 7, 8, 15, 10, 14];
const SPARE = Array.from({ length: 16 }, (_, i) => i).filter((i) => !USED.includes(i));
const efiUnlocked = ref(false);

// Back means the factory value, not whatever the uploaded file carried: on an
// image someone else already recoloured, that is their choice, not a baseline.
function revert(index: number) {
	const next = new Map(edits.value);
	next.delete(index);
	edits.value = next;
	restored.value = new Set(restored.value).add(index);
	downloadUrl.value = "";
}

// Everything back to factory in one go, expressed as edits rather than by
// clearing them: on an image that arrived already recoloured, dropping the
// edits would restore somebody else's palette, not the board's.
function resetAll() {
	edits.value = new Map();
	restored.value = new Set(Array.from({ length: STOCK.screen.length }, (_, i) => i));
	downloadUrl.value = "";
}

const offStock = (index: number) => (previewColors.value[index] ?? 0) !== (STOCK.screen[index] ?? 0);

function withEdits(base: number[], stock: number[]): number[] {
	const out = [...base];
	for (const i of restored.value) out[i] = stock[i] ?? 0;
	for (const [i, c] of edits.value) out[i] = c;
	return out;
}

const previewColors = computed(() => withEdits(info.value?.palettes[0]?.colors ?? [], STOCK.screen));
const popupColors = computed(() => withEdits(info.value?.palettes[1]?.colors ?? [], STOCK.popups));
// The factory tables, not the uploaded file's: someone comparing a ROM that
// was already recoloured needs to see what the board shipped with.
const originalColors = STOCK.screen;
const originalPopupColors = STOCK.popups;

const currentColor = computed({
	get: () => hex(previewColors.value[selected.value] ?? 0),
	set: (v: string) => {
		const next = new Map(edits.value);
		next.set(selected.value, Number.parseInt(v.slice(1), 16));
		edits.value = next;
	},
});

const imageRows = computed(() => {
	const i = info.value;
	if (!i) return [];
	return [
		pair(t("bc250.revision"), i.revision),
		pair(t("bc250.files"), String(i.fileCount)),
		pair(t("bc250.compressed"), kb(i.budget.compressed)),
		pair(t("bc250.slack"), kb(i.budget.compressedSlack)),
		pair(t("bc250.volumeFree"), `${i.budget.volumeSlack} bytes`),
	];
});

const BAR = W - 4 - 6;
const bar = computed(() => {
	const on = Math.round(progress.value * BAR);
	return "█".repeat(on) + "░".repeat(BAR - on) + " " + String(Math.round(progress.value * 100)).padStart(3) + "%";
});

// Contrast is checked on the pairs the board actually draws, taken from the
// attribute map: a palette can look fine as sixteen squares and still put text
// on a background it cannot be read against. Index 0 is the usual casualty,
// since it is a background almost everywhere and text in exactly one place.
const PAIRS: { fg: number; bg: number; what: string }[] = [
	{ fg: 1, bg: 7, what: "bodyText" },
	{ fg: 0, bg: 7, what: "headings" },
	{ fg: 8, bg: 7, what: "readOnly" },
	{ fg: 15, bg: 7, what: "values" },
	{ fg: 15, bg: 1, what: "titleBar" },
	{ fg: 7, bg: 1, what: "footer" },
	{ fg: 15, bg: 0, what: "console" },
];

function luminance(rgb: number): number {
	const ch = (v: number) => {
		const s = v / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * ch((rgb >> 16) & 255) + 0.7152 * ch((rgb >> 8) & 255) + 0.0722 * ch(rgb & 255);
}

function ratio(a: number, b: number): number {
	const la = luminance(a);
	const lb = luminance(b);
	return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

// The index number is shown as a chip of its own colour, with the text flipped
// to whichever of black or white stays legible on it: naming a colour in that
// same colour is how you get an invisible label.
function chip(index: number) {
	const rgb = previewColors.value[index] ?? 0;
	return {
		background: hex(rgb),
		color: luminance(rgb) > 0.4 ? "#000000" : "#ffffff",
	};
}

const contrastProblems = computed(() =>
	PAIRS.map((p) => ({
		...p,
		r: ratio(previewColors.value[p.fg] ?? 0, previewColors.value[p.bg] ?? 0),
	}))
		.filter((p) => p.r < 3)
		.sort((a, b) => a.r - b.r),
);

const risky = computed(() => [...edits.value.keys()].some((i) => i !== SAFE_INDEX));

async function onFile(file?: File | null) {
	if (!file) return;
	filename.value = file.name;
	downloadUrl.value = "";
	edits.value = new Map();
	restored.value = new Set();
	newLogo.value = null;
	await load(file);
}

function onDrop(e: DragEvent) {
	dragging.value = false;
	onFile(e.dataTransfer?.files?.[0]);
}

function reset() {
	edits.value = new Map();
	restored.value = new Set();
	umaTypable.value = false;
	selected.value = SAFE_INDEX;
	newLogo.value = null;
	logoSource.value = null;
	customSize.value = false;
	downloadUrl.value = "";
}

async function generate() {
	error.value = "";
	try {
		downloadUrl.value = URL.createObjectURL(await build(edits.value, restored.value, newLogo.value?.bytes, umaTypable.value));
	} catch (e) {
		console.error("[bc250] generate", e);
		error.value = e instanceof Error ? e.message : String(e);
		progress.value = 0;
	}
}

const newLogo = ref<{ bytes: Uint8Array; url: string; width: number; height: number } | null>(null);
const logoError = ref("");
const logoSource = ref<File | null>(null);
const customSize = ref(false);
const logoW = ref(0);
const logoH = ref(0);
const logoFill = ref(false);

// The ceiling is the panel, not a number invented here: the firmware centres
// the image at its own pixel size, so past the display mode there is nowhere
// left to draw. 1024x768 is what has been flashed and booted. 1x1 stays
// reachable at the bottom, which is how other BC-250 images ship with no
// splash at all. Whether a given size actually fits is a separate question,
// measured per image and refused at build time.
const MAX_W = 1920;
const MAX_H = 1080;
const clamp = (n: number, max: number) => Math.max(1, Math.min(max, Math.round(n) || 1));

const onScreen = (w: number) => ({ width: Math.min(100, (w / 1920) * 100) + "%" });

async function onLogo(file?: File | null) {
	if (!file) return;
	logoSource.value = file;
	await renderLogo();
}

// Falls back to the logo already in the ROM, so the canvas can be resized
// without picking a new picture: wanting the existing splash bigger is a
// perfectly ordinary thing to want.
async function sourceBitmap(): Promise<ImageBitmap | null> {
	if (logoSource.value) return await createImageBitmap(logoSource.value);
	const url = info.value?.logo?.url;
	if (!url) return null;
	return await createImageBitmap(await (await fetch(url)).blob());
}

async function renderLogo() {
	if (!info.value?.logo) return;
	if (!logoSource.value && !customSize.value) return;
	logoError.value = "";
	// The other format probably works, but stick to the one the ROM ships.
	const { format } = info.value.logo;
	const width = customSize.value ? clamp(logoW.value, MAX_W) : info.value.logo.width;
	const height = customSize.value ? clamp(logoH.value, MAX_H) : info.value.logo.height;
	try {
		const bitmap = await sourceBitmap();
		if (!bitmap) return;
		const canvas = document.createElement("canvas");
		canvas.width = width;
		canvas.height = height;
		const ctx = canvas.getContext("2d");
		if (!ctx) throw new Error("no 2d context");
		ctx.fillStyle = "#000";
		ctx.fillRect(0, 0, width, height);

		const pick = logoFill.value ? Math.max : Math.min;
		const scale = pick(width / bitmap.width, height / bitmap.height);
		const w = bitmap.width * scale;
		const h = bitmap.height * scale;
		ctx.drawImage(bitmap, (width - w) / 2, (height - h) / 2, w, h);

		const mime = `image/${format}`;
		const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, mime, 0.92));
		if (!blob) throw new Error(`could not encode ${format}`);
		newLogo.value = {
			bytes: new Uint8Array(await blob.arrayBuffer()),
			url: URL.createObjectURL(blob),
			width,
			height,
		};
	} catch (e) {
		console.error("[bc250] rendering the logo", e);
		logoError.value = e instanceof Error ? e.message : String(e);
	}
}

watch([customSize, logoW, logoH, logoFill], () => {
	const w = clamp(logoW.value, MAX_W);
	const h = clamp(logoH.value, MAX_H);
	if (w !== logoW.value) logoW.value = w;
	if (h !== logoH.value) logoH.value = h;
	downloadUrl.value = "";
	renderLogo();
});

watch(info, () => {
	logoW.value = info.value?.logo?.width ?? 0;
	logoH.value = info.value?.logo?.height ?? 0;
});


const ansiFont = ref("1.5rem");

/* The frame is 62 monospace cells of literal text, so the box can only fit if
   the type does. The advance width is whatever font actually resolved, which
   differs per machine, so it gets measured instead of assumed. */
function fitAnsi() {
	const probe = document.createElement("span");
	probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre;font-size:100px;font-family:var(--font-mono)";
	probe.textContent = "0".repeat(62);
	document.body.appendChild(probe);
	const per = probe.getBoundingClientRect().width / 100;
	probe.remove();
	if (!per) return;
	const room = document.documentElement.clientWidth - 32;
	ansiFont.value = Math.min(24, Math.floor((room / per) * 100) / 100) + "px";
}

onMounted(() => {
	fitAnsi();
	window.addEventListener("resize", fitAnsi);
});
onBeforeUnmount(() => window.removeEventListener("resize", fitAnsi));

// The download waits on the user actually looking. One button swaps every
// preview back to the palette the ROM arrived with, and until it has been used
// there is nothing to tick: a contrast problem is invisible unless you have
// seen what it replaced.
const showOriginal = ref(false);
const didCompare = ref(false);
const contrastOk = ref(false);
const blink = ref(false);
const blinkCompare = ref(false);

function toggleOriginal() {
	showOriginal.value = !showOriginal.value;
	didCompare.value = true;
}

const shown = computed(() => (showOriginal.value ? originalColors : previewColors.value));
const shownPopup = computed(() =>
	showOriginal.value ? originalPopupColors : popupColors.value,
);

function flash(flag: Ref<boolean>) {
	flag.value = false;
	requestAnimationFrame(() => (flag.value = true));
	setTimeout(() => (flag.value = false), 1600);
}

// Blocked download points at whichever box is unticked; ticking one without
// having looked points back at the button that shows what you are replacing.
const nudge = () => flash(didCompare.value ? blink : blinkCompare);

watch(acked, (on) => {
	if (on && !didCompare.value) flash(blinkCompare);
});

const unlocked = computed(() => acked.value && contrastOk.value);

const outName = computed(() => filename.value.replace(/\.(rom|bin)$/i, "") + "_recoloured.ROM");
</script>

<template>
  <div class="ansi-page" :style="{ '--ansi-font': ansiFont }">
    <div class="ansi-screen">
      <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.title")) }}</div>
      <div class="ansi-line"><span class="row-edge">║ </span><span class="body-text">{{ pad("") }}</span><span class="row-edge"> ║</span></div>
      <div v-for="(l, i) in lines('intro')" :key="i" class="ansi-line">
        <span class="row-edge">║ </span><span class="body-text">{{ pad(l) }}</span><span class="row-edge"> ║</span>
      </div>
      <div class="ansi-line"><span class="row-edge">║ </span><span class="body-text">{{ pad("") }}</span><span class="row-edge"> ║</span></div>
      <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
    </div>

    <div class="ansi-screen warn" data-testid="risk">
      <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.riskTitle")) }}</div>
      <div v-for="(l, i) in lines('risk')" :key="i" class="ansi-line">
        <span class="row-edge">║ </span><span class="body-text">{{ pad(l) }}</span><span class="row-edge"> ║</span>
      </div>
      <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
    </div>

    <label
      class="ansi-screen drop"
      :class="{ over: dragging }"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <input type="file" accept=".rom,.bin,.ROM,.BIN" @change="onFile(($event.target as HTMLInputElement).files?.[0])">
      <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.input")) }}</div>
      <div class="ansi-line"><span class="row-edge">║ </span><span class="body-text">{{ pad("") }}</span><span class="row-edge"> ║</span></div>
      <div class="ansi-line">
        <span class="row-edge">║ </span>
        <span class="body-text" data-testid="drop-label">{{
          busy ? pad("  " + status + " ...") : info ? pad("  " + filename) : pad("  " + t("bc250.drop"))
        }}</span>
        <span class="row-edge"> ║</span>
      </div>
      <div class="ansi-line"><span class="row-edge">║ </span><span class="body-text">{{ pad("") }}</span><span class="row-edge"> ║</span></div>
      <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
    </label>

    <div v-if="error" class="ansi-screen err" data-testid="error">
      <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.error")) }}</div>
      <div class="ansi-line"><span class="row-edge">║ </span><span class="body-text">{{ pad("  " + error) }}</span><span class="row-edge"> ║</span></div>
      <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
    </div>

    <template v-if="info">
      <div class="ansi-screen" data-testid="image-info">
        <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.image")) }}</div>
        <div v-for="(row, i) in imageRows" :key="i" class="ansi-line">
          <span class="row-edge">║ </span><span class="body-text">{{ row }}</span><span class="row-edge"> ║</span>
        </div>
        <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
      </div>

      <div v-if="info.logo" class="ansi-screen">
        <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.logo")) }}</div>
        <div class="previews">
          <figure class="preview">
            <div class="screen-frame" :style="{ background: hex(shown[0] ?? 0) }">
              <img :src="info.logo.url" :style="onScreen(info.logo.width)" alt="boot logo">
            </div>
            <figcaption class="dim-text">
              {{ t("bc250.logoSize") }} · {{ info.logo.width }}x{{ info.logo.height }} · {{ info.logo.bytes }} bytes
            </figcaption>
          </figure>
          <figure v-if="newLogo" class="preview">
            <div class="screen-frame" :style="{ background: hex(shown[0] ?? 0) }">
              <img :src="newLogo.url" :style="onScreen(newLogo.width)" alt="new boot logo">
            </div>
            <figcaption class="dim-text">
              {{ t("bc250.logoNew") }} · {{ newLogo.width }}x{{ newLogo.height }} · {{ newLogo.bytes.length }} bytes
            </figcaption>
          </figure>
        </div>
        <div class="logo-row centre">
          <span class="dim-text">{{ t("bc250.logoScreen") }}</span>
        </div>
        <div class="logo-row">
          <button class="link" data-testid="logo-size" @click="customSize = !customSize">
            {{ customSize ? t("bc250.logoSizeKeep") : t("bc250.logoSizeCustom") }}
          </button>
        </div>
        <template v-if="customSize">
          <div class="logo-row">
            <span class="dim-text">{{ t("bc250.logoSizeLabel") }}</span>
            <input v-model.number="logoW" class="numin" type="number" min="16" :max="MAX_W" data-testid="logo-w">
            <span class="dim-text">x</span>
            <input v-model.number="logoH" class="numin" type="number" min="16" :max="MAX_H" data-testid="logo-h">
            <SCheckbox v-model="logoFill" class="tick">{{ t("bc250.logoFill") }}</SCheckbox>
          </div>
          <div v-for="(l, i) in lines('logoSizeNote')" :key="i" class="ansi-line">
            <span class="row-edge">║ </span><span class="dim-text">{{ pad(l) }}</span><span class="row-edge"> ║</span>
          </div>
        </template>
        <div class="logo-row">
          <label class="link pick">
            <input type="file" accept="image/*" data-testid="logo-input" @change="onLogo(($event.target as HTMLInputElement).files?.[0])">
            {{ newLogo ? t("bc250.logoChange") : t("bc250.logoPick") }}
          </label>
          <span v-if="logoError" class="dim-text">{{ logoError }}</span>
        </div>
        <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
      </div>
      <div class="ansi-screen" data-testid="warning">
        <div class="ansi-frame ansi-frame--titled">{{ top("!") }}</div>
        <div v-for="(l, i) in lines('warning')" :key="i" class="ansi-line">
          <span class="row-edge">║ </span><span class="body-text">{{ pad(l) }}</span><span class="row-edge"> ║</span>
        </div>
        <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
      </div>


      <div class="ansi-screen">
        <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.palettes")) }}</div>
        <div class="pal">
          <span class="dim-text pal-name">{{ t("bc250.groupBios") }}</span>
          <span class="swatches">
            <span
              v-for="i in USED"
              :key="i"
              class="swatch"
              :title="`${i}: ${hex(previewColors[i] ?? 0)} — ${ROLES[i]}`"
              ><label class="sw-box"><input
                type="color"
                class="sw"
                :class="{ marked: i === selected }"
                :value="hex(previewColors[i] ?? 0)"
                @focus="selected = i"
                @input="paint(i, ($event.target as HTMLInputElement).value)"
              ></label><span class="sw-i">{{ i }}</span><button
                class="sw-x"
                :class="{ on: offStock(i) }"
                :disabled="!offStock(i)"
                :title="t('bc250.revert')"
                @click="revert(i)"
              >x</button></span>
          </span>
        </div>
        <div class="pal">
          <span class="dim-text pal-name">{{ t("bc250.groupEfi") }}</span>
          <span class="swatches">
            <span
              v-for="i in SPARE"
              :key="i"
              class="swatch"
              :title="`${i}: ${hex(previewColors[i] ?? 0)} — ${ROLES[i]}`"
              ><label class="sw-box"><input
                type="color"
                class="sw"
                :disabled="!efiUnlocked"
                :class="{ marked: i === selected }"
                :value="hex(previewColors[i] ?? 0)"
                @focus="selected = i"
                @input="paint(i, ($event.target as HTMLInputElement).value)"
              ></label><span class="sw-i">{{ i }}</span><button
                class="sw-x"
                :class="{ on: offStock(i) }"
                :disabled="!offStock(i)"
                :title="t('bc250.revert')"
                @click="revert(i)"
              >x</button></span>
          </span>
        </div>
        <div class="pal-actions">
          <SCheckbox v-model="efiUnlocked" class="tick" data-testid="efi">{{ t("bc250.editEfi") }}</SCheckbox>
        </div>
        <div class="pal-actions">
          <button
            v-if="[...USED, ...SPARE].some((i) => offStock(i))"
            class="link"
            data-testid="reset-all"
            @click="resetAll"
          >{{ t("bc250.resetAll") }}</button>
        </div>
        <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
      </div>

      <Bc250Screen :colors="shown" :popup-colors="shownPopup" />
      <Bc250Console :colors="shown" />

      <div v-if="info.uma" class="ansi-screen" data-testid="uma">
        <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.umaTitle")) }}</div>
        <div v-for="(l, i) in lines('umaNote')" :key="i" class="ansi-line">
          <span class="row-edge">║ </span><span class="dim-text">{{ pad(l) }}</span><span class="row-edge"> ║</span>
        </div>
        <div class="actions">
          <SCheckbox
            v-if="!info.uma.typable"
            v-model="umaTypable"
            class="tick"
            data-testid="uma-check"
          >{{ t("bc250.umaEnable") }}</SCheckbox>
          <span v-else class="dim-text">{{ t("bc250.umaAlready") }}</span>
        </div>
        <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
      </div>

      <div v-if="contrastProblems.length" class="ansi-screen warn" data-testid="contrast-warn">
        <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.contrastTitle")) }}</div>
        <div v-for="p in contrastProblems" :key="p.what" class="warn-row">
          <span
            class="sample"
            :style="{ background: hex(previewColors[p.bg] ?? 0), color: hex(previewColors[p.fg] ?? 0) }"
          >{{ t("bc250.pair." + p.what) }}</span>
          <span class="body-text">{{ t("bc250.foreground") }}</span>
          <span class="idx" :style="chip(p.fg)">{{ p.fg }}</span>
          <span class="body-text">{{ t("bc250.onBackground") }}</span>
          <span class="idx" :style="chip(p.bg)">{{ p.bg }}</span>
          <span class="body-text">{{ p.r.toFixed(2) }}:1</span>
          <span class="body-text">{{ t("bc250.hardToRead") }}</span>
        </div>
        <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
      </div>

      <div class="ansi-screen">
        <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.output")) }}</div>
        <div class="actions">
          <button class="link" :disabled="busy || (!edits.size && !restored.size && !newLogo && !umaTypable)" data-testid="generate" @click="generate">
            {{ busy ? status + " ..." : t("bc250.generate") }}
          </button>
          <a
            v-if="downloadUrl && unlocked"
            class="link"
            data-testid="download"
            :href="downloadUrl"
            :download="outName"
          >{{ t("bc250.download") }}</a>
          <button
            v-else-if="downloadUrl"
            class="link off"
            data-testid="download-blocked"
            @click="nudge"
          >{{ t("bc250.download") }}</button>
          <button class="link" :class="{ blink: blinkCompare }" data-testid="compare" @click="toggleOriginal">
            {{ showOriginal ? t("bc250.compareBack") : t("bc250.compare") }}
          </button>
        </div>

        <template v-if="downloadUrl">
          <div class="actions" :class="{ blink }">
            <SCheckbox v-model="acked" class="tick" data-testid="ack">{{ t("bc250.ack") }}</SCheckbox>
          </div>
          <div v-if="didCompare" class="actions" :class="{ blink }">
            <SCheckbox v-model="contrastOk" class="tick" data-testid="contrast">
              {{ t("bc250.contrastAck") }}
            </SCheckbox>
          </div>
          <div v-else class="ansi-line">
            <span class="row-edge">║ </span><span class="dim-text">{{ pad("  " + t("bc250.reviewHint")) }}</span><span class="row-edge"> ║</span>
          </div>
          <div v-if="!unlocked" class="ansi-line">
            <span class="row-edge">║ </span><span class="dim-text">{{ pad("  " + t("bc250.blocked")) }}</span><span class="row-edge"> ║</span>
          </div>
        </template>
        <div class="ansi-line" data-testid="progress">
          <span class="row-edge">║ </span><span class="body-text">{{ pad(bar) }}</span><span class="row-edge"> ║</span>
        </div>
        <div v-if="busy" class="ansi-line">
          <span class="row-edge">║ </span><span class="dim-text">{{ pad("  " + status + " ...") }}</span><span class="row-edge"> ║</span>
        </div>
        <div v-if="error" class="ansi-line" data-testid="output-error">
          <span class="row-edge">║ </span><span class="body-text">{{ pad("  " + t("bc250.failed") + " " + error) }}</span><span class="row-edge"> ║</span>
        </div>
        <div class="ansi-line"><span class="row-edge">║ </span><span class="dim-text">{{ pad(t("bc250.verifyNote")) }}</span><span class="row-edge"> ║</span></div>
        <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
      </div>
    </template>
  </div>

</template>

<style scoped>

.ansi-page {
  min-height: 100vh;
  background: var(--color-background);
  padding: 24px 12px 64px;
  position: relative;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.ansi-screen {
  font-family: var(--font-mono);
  background: var(--color-background);
  color: var(--color-text-primary);
  font-size: var(--ansi-font, 1.5rem);
  font-weight: 400;
  line-height: 1;
  letter-spacing: 0;
  font-variant-ligatures: none;
  font-feature-settings: "liga" 0, "calt" 0, "kern" 0;
  -webkit-font-smoothing: none;
  -moz-osx-font-smoothing: grayscale;
  font-smooth: never;
  text-rendering: geometricPrecision;
  white-space: pre;
  width: max-content;
  max-width: 100%;
  overflow: clip;
  box-shadow:
    0 0 0 2px var(--color-border),
    6px 6px 0 var(--color-border);
}

.ansi-screen > * { padding: 0; margin: 0; }

.ansi-frame,
.row-edge {
  color: color-mix(in srgb, var(--color-text-tertiary) 70%, transparent);
  background: var(--color-background);
}
.ansi-frame--titled { color: var(--color-text-secondary); }
.ansi-line { color: var(--color-text-primary); }
.body-text { color: var(--color-text-primary); }
.dim-text { color: var(--color-text-secondary); }

/* The box sizes itself to its widest child, and these rows hold widgets rather
   than text. Letting them count would stretch the box past the 62 characters
   the border is drawn with, leaving it visibly short. */
.pal, .picker-row, .logo-row, .pal-actions, .actions {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 16px;
  width: 0;
  min-width: 100%;
}
.warn-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 16px;
  width: 0;
  min-width: 100%;
  font-size: 1.1rem;
  flex-wrap: wrap;
}

.idx {
  padding: 2px 8px;
  flex: none;
  border: 1px solid var(--color-text-tertiary);
  font-variant-numeric: tabular-nums;
}

.sample {
  padding: 3px 10px;
  flex: none;
  border: 1px solid var(--color-text-tertiary);
}

.chip {
  width: 26px;
  height: 20px;
  flex: none;
  border: 1px solid var(--color-text-tertiary);
}

.pal-name { flex: 0 0 13ch; white-space: nowrap; }
.swatches { display: flex; gap: 7px; flex: 1; justify-content: center; }

.swatch {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  flex: 0 0 34px;
}

.sw-box { display: block; line-height: 0; }

.sw-i {
  font-family: inherit;
  font-size: 0.9rem;
  color: var(--color-text-secondary);
  font-variant-numeric: tabular-nums;
}

/* indices nothing on screen uses, kept last and played down */
.spare { opacity: 0.68; }
.spare .sw-i { color: var(--color-text-tertiary); }

/* an edited index offers itself back. the slot is always there so the row does
   not jump when one appears */
.sw-x {
  font-family: inherit;
  font-size: 0.9rem;
  line-height: 1;
  background: none;
  border: none;
  padding: 0;
  visibility: hidden;
  color: var(--color-text-tertiary);
  cursor: pointer;
}

.sw-x.on { visibility: visible; color: var(--color-text-primary); }
/* a native colour input paints its swatch inset inside its own chrome, which
   reads as gaps and doubled edges once they sit side by side */
.sw {
  appearance: none;
  -webkit-appearance: none;
  width: 34px;
  min-width: 0;
  height: 34px;
  padding: 0;
  background: none;
  border: 1px solid var(--color-text-tertiary);
  cursor: pointer;
}

.sw::-webkit-color-swatch-wrapper { padding: 0; }
.sw::-webkit-color-swatch { border: none; }
.sw::-moz-color-swatch { border: none; }
.sw.marked { outline: 3px solid var(--color-text-primary); outline-offset: -3px; }

.drop { cursor: pointer; }
.drop input { display: none; }
.drop.over .body-text { color: var(--color-text-secondary); }

.err, .warn { box-shadow: 0 0 0 2px var(--color-text-primary), 6px 6px 0 var(--color-border); }

.grow { flex: 1; text-align: right; }

.previews {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 20px;
  padding: 12px 16px;
  width: 0;
  min-width: 100%;
}

.preview {
  margin: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  flex: 1 1 min(340px, 100%);
  min-width: 0;
  max-width: 520px;
}

.screen-frame {
  width: 100%;
  aspect-ratio: 16 / 9;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
}

.screen-frame img { image-rendering: pixelated; height: auto; }

.preview figcaption { font-size: 1rem; text-align: center; }

.centre { justify-content: center; }

.numin {
  font-family: var(--font-mono);
  font-size: 1.1rem;
  width: 9ch;
  background: var(--color-background);
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
  padding: 4px 6px;
}

/* the ANSI screen sets white-space: pre, which stops this label wrapping
   and pushes the frame wider than its own border */
.link.off { opacity: 0.5; }

/* the blocked download nudges whichever box is still unticked, rather than
   silently doing nothing */
@keyframes nudge {
  0%, 100% { background: transparent; }
  25%, 75% { background: color-mix(in srgb, var(--color-text-primary) 22%, transparent); }
}

.actions.blink,
.link.blink { animation: nudge 0.4s ease-in-out 3; }

@media (prefers-reduced-motion: reduce) {
  .actions.blink,
  .link.blink { animation: none; outline: 2px solid var(--color-text-primary); }
}

/* the pixel checkbox is drawn with an inset shadow, which at this type size
   comes out as a hairline; thicker and squarer reads like the rest of the page */
.tick :deep(.s-check__box) {
  width: 1.15em;
  height: 1.15em;
  box-shadow: inset 0 0 0 3px var(--color-text-primary);
  border-radius: 0;
}

.tick :deep(input:checked ~ .s-check__box) {
  background: var(--color-text-primary);
  box-shadow: inset 0 0 0 3px var(--color-text-primary);
  color: var(--color-background);
}

.tick :deep(.s-check__box::before) { font-weight: 700; font-size: 0.9em; }

.tick {
  white-space: normal;
  max-width: min(46ch, 100%);
  font-size: 1.1rem;
  color: var(--color-text-secondary);
  align-items: flex-start;
}

.hexin {
  background: var(--color-background); color: var(--color-text-primary);
  border: 1px solid var(--color-border); font-family: inherit;
  font-size: 1.5rem; padding: 6px 10px; width: 140px;
}

.link {
  background: none; border: none; color: var(--color-text-primary);
  font-family: inherit; font-size: 1.5rem; cursor: pointer;
  padding: 0; text-decoration: none;
}
.pick input { display: none; }
.link:disabled { color: var(--color-text-tertiary); cursor: default; }
.link:hover:not(:disabled) { color: var(--color-text-secondary); }
</style>

