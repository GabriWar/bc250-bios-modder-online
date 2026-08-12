<script setup lang="ts">

const props = defineProps<{ colors: number[] }>();

const hex = (n: number) => "#" + n.toString(16).padStart(6, "0");
const bg = (attr: number) => hex(props.colors[(attr >> 4) & 0x7] ?? 0);
const fg = (attr: number) => hex(props.colors[attr & 0xf] ?? 0);

const A = {
	title: 0x71,
	body: 0x71,
	selected: 0x17,
	help: 0x70,
	section: 0x7f,
};

const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

const left = [
	{ attr: A.section, text: " Memory" },
	{ attr: A.body, text: "   UMA Frame Buffer Size          [1024]" },
	{ attr: A.selected, text: "   Integrated Graphics           <Forces>" },
	{ attr: A.body, text: "   UMA Mode                      <UMA_SPECIFIED>" },
	{ attr: A.body, text: "" },
	{ attr: A.section, text: " Platform" },
	{ attr: A.body, text: "   ACPI C-State Fix              [X]" },
	{ attr: A.body, text: "   CPU Cores                     <8 cores>" },
	{ attr: A.body, text: "   IOMMU                         <Auto>" },
];

const help = [
	"Type any value from 256",
	"to 15360 MB.",
	"",
	"1 GB  = 1024",
	"4 GB  = 4096",
	"12 GB = 12288",
	"",
	"->/<-: Select Screen",
	"Enter: Select",
];
</script>

<template>
  <div class="screen">
    <div class="line" :style="{ background: bg(A.title), color: fg(A.title) }">
      {{ pad(" gabriwar BC-250 Setup Utility - (C) 2022 GabriWar", 78) }}
    </div>
    <div class="line" :style="{ background: bg(A.body), color: fg(A.body) }">
      {{ pad("  Main  Advanced  Chipset  Security  Boot  Save & Exit", 78) }}
    </div>

    <div class="split">
      <div>
        <div
          v-for="(row, i) in left"
          :key="i"
          class="line"
          :style="{ background: bg(row.attr), color: fg(row.attr) }"
        >{{ pad(row.text, 50) }}</div>
      </div>
      <div>
        <div
          v-for="(row, i) in help"
          :key="i"
          class="line"
          :style="{ background: bg(A.help), color: fg(A.help) }"
        >{{ pad(" " + row, 28) }}</div>
      </div>
    </div>

    <div class="line" :style="{ background: bg(A.body), color: fg(A.body) }">
      {{ pad(" Version 2.22.1284. (C) 2022                  ~by GabriWar", 78) }}
    </div>
  </div>
</template>

<style scoped>
.screen {
  font-family: 'Cozette', 'Courier New', monospace;
  font-size: 18px;
  line-height: 1.35;
  padding: 6px 0;
  overflow-x: auto;
  border: 1px solid #1e1e1e;
}
.line { white-space: pre; }
.split { display: flex; }
</style>

