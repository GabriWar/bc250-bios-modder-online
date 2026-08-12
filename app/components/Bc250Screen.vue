<script setup lang="ts">
const props = defineProps<{ colors: number[]; popupColors?: number[] }>();

const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
const pick = (set: number[], i: number) => hex(set[i] ?? 0);
const bg = (attr: number) => pick(props.colors, (attr >> 4) & 0x7);
const fg = (attr: number) => pick(props.colors, attr & 0xf);
const pbg = (attr: number) => pick(props.popupColors ?? props.colors, (attr >> 4) & 0x7);
const pfg = (attr: number) => pick(props.popupColors ?? props.colors, attr & 0xf);

// Attribute bytes this BIOS paints with, (bg << 4) | fg. A row is highlighted
// by swapping the nibbles, which is why 1 and 7 carry the screen: 1 on 7 is
// body text, 7 on 1 is the title bar and the selected row. Dialogs are 0x1f,
// so index 1 is also the popup background and 15 the text inside it.
// Read off a flashed board painted with 16 unmistakable colours, one per
// index, rather than inferred: several of these are not what they look like.
// Section headings are index 0, which also paints the POST background and the
// shadow a dialog casts. Read-only fields are index 8, not 0. The value column
// is index 15, the same yellow as the title bar, while the footer uses 7.
const A = {
	title: 0x1f,
	footer: 0x17,
	body: 0x71,
	heading: 0x70,
	info: 0x78,
	value: 0x7f,
	popup: 0x1f,
	popupSel: 0x0f,
};

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

const LEFT = 46;
const RIGHT = 32;
const ROWS = 18;

// Read-only fields are painted with index 0, the same colour as the help pane;
// anything the user can change uses index 1. Read off a photo of the flashed
// board rather than guessed: it is the reason index 0 matters at all, and why a
// low-contrast choice there washes out half the screen.
type Row = { label: string; value?: string; attr: number; valueAttr?: number };

const left: Row[] = [
	{ label: "BIOS Information", attr: A.heading },
	{ label: "BIOS Vendor", value: "American Megatrends", attr: A.info, valueAttr: A.info },
	{ label: "Core Version", value: "5.13", attr: A.info, valueAttr: A.info },
	{ label: "Compliancy", value: "UEFI 2.6; PI 1.4", attr: A.info, valueAttr: A.info },
	{ label: "Project Version", value: "A2736 5.00 x64", attr: A.info, valueAttr: A.info },
	{ label: "Build Date and Time", value: "05/03/2022 11:34:10", attr: A.info, valueAttr: A.info },
	{ label: "Access Level", value: "Administrator", attr: A.info, valueAttr: A.info },
	{ label: "", attr: A.body },
	{ label: "Memory Information", attr: A.heading },
	{ label: "  Total Memory", value: "Total Memory: 16384 MB", attr: A.info, valueAttr: A.info },
	{ label: "", attr: A.body },
	{ label: "System Language", value: "[English]", attr: A.value, valueAttr: A.value },
	{ label: "> Main", attr: A.body },
	{ label: "", attr: A.body },
	{ label: "System Date", value: "[Wed 08/12/2026]", attr: A.body, valueAttr: A.body },
	{ label: "System Time", value: "[02:17:02]", attr: A.body, valueAttr: A.body },
];

const right = [
	"Choose the system default",
	"language",
	"",
	"",
	"",
	"",
	"",
	"-",
	"->/<-: Select Screen",
	"^v: Select Item",
	"Enter: Select",
	"+/-: Change Option",
	"F1: General Help",
	"F7: Discard Changes",
	"F9: Load UEFI Defaults",
	"F10: Save and Exit",
	"ESC: Exit",
];

const rowsLeft = Array.from({ length: ROWS }, (_, i) => left[i] ?? { label: "", attr: A.body });
const rowsRight = Array.from({ length: ROWS }, (_, i) => right[i] ?? "");
const rule = "-".repeat(RIGHT - 2);
</script>

<template>
  <div class="screen" :style="{ background: bg(A.body) }">
    <div class="line" :style="{ background: bg(A.title), color: fg(A.title) }">
      {{ pad(" gabriwar BC-250 Setup Utility - (C) 2022 GabriWar", LEFT + RIGHT + 1) }}
    </div>

    <div class="line" :style="{ background: bg(A.body), color: fg(A.body) }"><span
      :style="{ background: bg(A.body), color: fg(A.body) }"
    >{{ " Main " }}</span>{{ pad("  Advanced  Chipset  Security  Boot  Save & Exit", LEFT + RIGHT - 5) }}</div>

    <div class="split">
      <div>
        <div
          v-for="(r, i) in rowsLeft"
          :key="i"
          class="line"
          :style="{ background: bg(r.attr), color: fg(r.attr) }"
        >{{ pad(" " + r.label, 24) }}<span
          :style="{ color: fg(r.valueAttr ?? r.attr) }"
        >{{ pad(r.value ?? "", LEFT - 24) }}</span></div>
      </div>

      <div class="rule-v" :style="{ background: fg(A.body) }" />

      <div>
        <div
          v-for="(l, i) in rowsRight"
          :key="'r' + i"
          class="line"
          :style="{ background: bg(A.body), color: fg(A.body) }"
        >{{ pad(l === "-" ? " " + rule : " " + l, RIGHT) }}</div>
      </div>
    </div>

    <div class="line" :style="{ background: bg(A.footer), color: fg(A.footer) }">
      {{ pad(" Version 2.18.1263. (C) 2022", LEFT + RIGHT - 13) }}{{ "~by GabriWar " }}
    </div>

    <!-- painted from the popup table, which is a separate 16-colour palette -->
    <div class="popup">
      <div class="shadow" :style="{ background: pbg(A.popupSel) }" />
      <div class="box" :style="{ background: pbg(A.popup), color: pfg(A.popup) }">
        <div class="line">{{ pad(" ---- System Language ----", 28) }}</div>
        <div class="line"><span
          :style="{ background: pbg(A.popupSel), color: pfg(A.popupSel) }"
        >{{ " English " }}</span>{{ pad("", 19) }}</div>
        <div class="line">{{ pad("", 28) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.screen {
  position: relative;
  display: inline-block;
  font-family: var(--font-mono);
  font-size: min(15px, calc((100vw - 28px) / 49));
  line-height: 1.3;
  max-width: 100%;
  overflow: clip;
  border: 1px solid var(--color-border);
}
.line { white-space: pre; }
.split { display: flex; }
.rule-v { width: 1px; }
.popup { position: absolute; left: 30%; top: 44%; }
.box { position: relative; }
/* the board paints the drop shadow with index 0, the same colour as the
   headings and the POST background */
.shadow { position: absolute; inset: 12px -14px -14px 12px; }
</style>
