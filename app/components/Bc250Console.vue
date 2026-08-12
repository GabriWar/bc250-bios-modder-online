<script setup lang="ts">
const props = defineProps<{ colors: number[] }>();

const hex = (n: number) => "#" + (props.colors[n] ?? 0).toString(16).padStart(6, "0");

// The shell paints over index 0 and colours entries by kind. Read off a board
// flashed twice with different palettes, so each of these is confirmed by two
// independent observations rather than one reading of one photo.
const bg = computed(() => hex(0));

const lines: { text: string; idx: number }[] = [
	{ text: "UEFI Interactive Shell v2.2", idx: 15 },
	{ text: "EDK II", idx: 15 },
	{ text: "UEFI v2.60 (American Megatrends, 0x0005000D)", idx: 15 },
	{ text: "Mapping table", idx: 14 },
	{ text: "      FS0: Alias(s):HD0e0c;;BLK3:", idx: 14 },
	{ text: "          PciRoot(0x0)/Pci(0x12,0x2)/USB(0x4,0x0)", idx: 15 },
	{ text: "     BLK0: Alias(s):", idx: 14 },
	{ text: "", idx: 15 },
	{ text: "Shell> ls", idx: 15 },
	{ text: "     16777216  BC250_P5GBW_8core.ROM", idx: 15 },
	{ text: "          185  flash.nsh", idx: 10 },
	{ text: "          186  debug.nsh", idx: 10 },
	{ text: "         4096  EFI", idx: 1 },
	{ text: "", idx: 15 },
	{ text: "Shell> flash.nsh", idx: 15 },
];
</script>

<template>
  <div class="console" :style="{ background: bg }">
    <div v-for="(l, i) in lines" :key="i" class="line" :style="{ color: hex(l.idx) }">{{ l.text || " " }}</div>
  </div>
</template>

<style scoped>
.console {
  font-family: 'Cozette', 'Courier New', monospace;
  font-size: min(15px, calc((100vw - 28px) / 49));
  line-height: 1.3;
  padding: 6px 8px;
  max-width: 100%;
  overflow: clip;
  border: 1px solid var(--color-border);
}
.line { white-space: pre; }
</style>
