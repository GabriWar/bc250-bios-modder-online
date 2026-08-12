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

const { busy, status, error, info, progress, load, build } = useBc250Bios();

const SAFE_INDEX = 1;

const dragging = ref(false);
const filename = ref("");
const downloadUrl = ref("");
const advanced = ref(false);
const acked = ref(false);
const selected = ref(SAFE_INDEX);

const edits = ref(new Map<number, number>());

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

function withEdits(base: number[]): number[] {
	const out = [...base];
	for (const [i, c] of edits.value) out[i] = c;
	return out;
}

const previewColors = computed(() => withEdits(info.value?.palettes[0]?.colors ?? []));
const popupColors = computed(() => withEdits(info.value?.palettes[1]?.colors ?? []));

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

const risky = computed(() => [...edits.value.keys()].some((i) => i !== SAFE_INDEX));

async function onFile(file?: File | null) {
	if (!file) return;
	filename.value = file.name;
	downloadUrl.value = "";
	edits.value = new Map();
	newLogo.value = null;
	await load(file);
}

function onDrop(e: DragEvent) {
	dragging.value = false;
	onFile(e.dataTransfer?.files?.[0]);
}

function reset() {
	edits.value = new Map();
	selected.value = SAFE_INDEX;
	newLogo.value = null;
	logoSource.value = null;
	customSize.value = false;
	downloadUrl.value = "";
}

async function generate() {
	error.value = "";
	try {
		downloadUrl.value = URL.createObjectURL(await build(edits.value, newLogo.value?.bytes));
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

// Bigger probably works too, this is just the size that was tested.
const MAX_W = 1024;
const MAX_H = 768;
const clamp = (n: number, max: number) => Math.max(16, Math.min(max, Math.round(n) || 16));

const onScreen = (w: number) => ({ width: Math.min(100, (w / 1920) * 100) + "%" });

async function onLogo(file?: File | null) {
	if (!file) return;
	logoSource.value = file;
	await renderLogo();
}

async function renderLogo() {
	const src = logoSource.value;
	if (!src || !info.value?.logo) return;
	logoError.value = "";
	// The other format probably works, but stick to the one the ROM ships.
	const { format } = info.value.logo;
	const width = customSize.value ? clamp(logoW.value, MAX_W) : info.value.logo.width;
	const height = customSize.value ? clamp(logoH.value, MAX_H) : info.value.logo.height;
	try {
		const bitmap = await createImageBitmap(src);
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
        <div class="ansi-line"><span class="row-edge">║ </span><span class="dim-text">{{ pad(t("bc250.slackNote")) }}</span><span class="row-edge"> ║</span></div>
        <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
      </div>

      <div v-if="info.logo" class="ansi-screen">
        <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.logo")) }}</div>
        <div class="previews">
          <figure class="preview">
            <div class="screen-frame" :style="{ background: hex(previewColors[0] ?? 0) }">
              <img :src="info.logo.url" :style="onScreen(info.logo.width)" alt="boot logo">
            </div>
            <figcaption class="dim-text">
              {{ t("bc250.logoSize") }} · {{ info.logo.width }}x{{ info.logo.height }} · {{ info.logo.bytes }} bytes
            </figcaption>
          </figure>
          <figure v-if="newLogo" class="preview">
            <div class="screen-frame" :style="{ background: hex(previewColors[0] ?? 0) }">
              <img :src="newLogo.url" :style="onScreen(newLogo.width)" alt="new boot logo">
            </div>
            <figcaption class="dim-text">
              {{ t("bc250.logoNew") }} · {{ newLogo.width }}x{{ newLogo.height }} · {{ newLogo.bytes.length }} bytes
            </figcaption>
          </figure>
        </div>
        <div class="logo-row centre"><span class="dim-text">{{ t("bc250.logoScreen") }}</span></div>
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

      <div class="ansi-screen">
        <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.palettes")) }}</div>
        <div v-for="p in info.palettes" :key="p.which" class="pal">
          <span class="dim-text pal-name">{{ p.which }}</span>
          <span class="swatches">
            <button
              v-for="(c, i) in withEdits(p.colors)"
              :key="i"
              class="sw"
              :class="{ marked: i === selected, locked: !advanced && i !== SAFE_INDEX }"
              :style="{ background: hex(c) }"
              :title="`${i}: ${hex(c)}`"
              :disabled="!advanced && i !== SAFE_INDEX"
              @click.prevent="selected = i"
            >{{ i }}</button>
          </span>
        </div>
        <div class="pal-actions">
          <button class="link" data-testid="advanced" @click="advanced = !advanced">
            {{ advanced ? t("bc250.advancedOff") : t("bc250.advanced") }}
          </button>
        </div>
        <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
      </div>

      <div v-if="advanced || risky" class="ansi-screen warn" data-testid="warning">
        <div class="ansi-frame ansi-frame--titled">{{ top("!") }}</div>
        <div v-for="(l, i) in lines('warning')" :key="i" class="ansi-line">
          <span class="row-edge">║ </span><span class="body-text">{{ pad(l) }}</span><span class="row-edge"> ║</span>
        </div>
        <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
      </div>

      <div class="ansi-screen">
        <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.colour")) }}</div>
        <div class="picker-row">
          <span class="dim-text">{{ t("bc250.index") }} {{ selected }}</span>
          <input v-model="currentColor" type="color" data-testid="picker">
          <input v-model="currentColor" class="hexin" spellcheck="false">
          <button v-if="edits.size" class="link" data-testid="reset" @click="reset">{{ t("bc250.reset") }}</button>
        </div>
        <div class="ansi-frame ansi-frame--titled">{{ bot() }}</div>
      </div>

      <Bc250Screen :colors="previewColors" :popup-colors="popupColors" />
        <Bc250Console :colors="previewColors" />

      <div class="ansi-screen">
        <div class="ansi-frame ansi-frame--titled">{{ top(t("bc250.output")) }}</div>
        <div class="actions">
          <button class="link" :disabled="busy || (!edits.size && !newLogo)" data-testid="generate" @click="generate">
            {{ busy ? status + " ..." : t("bc250.generate") }}
          </button>
          <a v-if="downloadUrl && acked" class="link" data-testid="download" :href="downloadUrl" :download="outName">
            {{ t("bc250.download") }}
          </a>
        </div>
        <div v-if="downloadUrl" class="actions">
          <SCheckbox v-model="acked" class="tick" data-testid="ack">{{ t("bc250.ack") }}</SCheckbox>
        </div>
        <div v-if="downloadUrl && !acked" class="ansi-line">
          <span class="row-edge">║ </span><span class="dim-text">{{ pad("  " + t("bc250.ackHint")) }}</span><span class="row-edge"> ║</span>
        </div>
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

.pal, .picker-row, .logo-row, .pal-actions, .actions {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  padding: 8px 16px;
  max-width: 100%;
}
.pal-name { flex: none; min-width: 7ch; }
.swatches { display: flex; gap: 3px; flex: 1; }
.sw {
  flex: 1 1 0; min-width: 0; height: 38px; padding: 0;
  border: 1px solid var(--color-border); cursor: pointer;
  font-family: inherit; font-size: 0.8rem; color: transparent;
}
.sw.marked { outline: 3px solid var(--color-text-primary); outline-offset: -3px; }
.sw.locked { cursor: default; opacity: 0.55; }

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
  max-width: 100%;
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
.tick {
  white-space: normal;
  max-width: min(46ch, 100%);
  font-size: 1.1rem;
  color: var(--color-text-secondary);
  align-items: flex-start;
}

input[type="color"] {
  width: 64px; height: 36px; padding: 0;
  background: none; border: 1px solid var(--color-border);
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

