<script setup lang="ts">
import type { MapNode } from "~/utils/bc250/map.ts";

const { t } = useI18n();

const props = withDefaults(
	defineProps<{
		node: MapNode;
		depth?: number;
		last?: boolean;
		openAll?: { open: boolean; n: number };
		selected?: number;
	}>(),
	{ depth: 0, last: true, openAll: () => ({ open: false, n: 0 }), selected: undefined },
);
const emit = defineEmits<{ select: [MapNode] }>();

// Deep branches are the interesting ones -- UMC Debug Options is four levels
// down and holds 170 options -- but opening everything at once buries the page,
// so a node starts closed unless it is a root.
//
// The expand-all state has to be read at mount, not only watched: a child is
// only created when its parent opens, and by then the button was pressed long
// ago, so a watcher alone leaves every newly revealed branch shut.
const open = ref(props.depth === 0 || props.openAll.open);

// A bump of the counter means expand-all or collapse-all was pressed. Watching
// the number rather than a boolean lets the same button be pressed twice.
watch(
	() => props.openAll.n,
	() => {
		open.value = props.openAll.open;
	},
);

const branch = computed(() => (props.depth === 0 ? "" : props.last ? "└─ " : "├─ "));
const badge = computed(() =>
	props.node.isTab
		? { text: t("bc250.mapBadgeTab"), kind: "tab" }
		: props.node.locked
			? { text: t("bc250.mapBadgeLock"), kind: "lock" }
			: null,
);
const hasKids = computed(() => props.node.children.length > 0);
</script>

<template>
	<div class="node" :style="{ marginLeft: depth ? '2ch' : '0' }">
		<div
			class="row clickable"
			:class="{ on: selected === node.id }"
			@click="emit('select', node)"
		>
			<span v-if="hasKids" class="caret hit" @click.stop="open = !open">{{ open ? "-" : "+" }}</span>
			<span v-else class="caret" />
			<span class="branch">{{ branch }}</span>
			<span class="title" :class="{ tab: node.isTab, locked: node.locked }">{{
				node.title ?? `form ${node.id}`
			}}</span>
			<span class="meta">0x{{ node.id.toString(16) }}</span>
			<span v-if="node.options" class="meta">{{ node.options }} {{ t("bc250.mapOpt") }}</span>
			<span v-else-if="node.rows" class="meta">{{ node.rows }} {{ t("bc250.mapInfo") }}</span>
			<span v-if="badge" class="badge" :class="badge.kind">{{ badge.text }}</span>
		</div>
		<template v-if="open">
			<Bc250MapNode
				v-for="(child, i) in node.children"
				:key="child.id"
				:node="child"
				:depth="depth + 1"
				:last="i === node.children.length - 1"
				:open-all="openAll"
				:selected="selected"
				@select="emit('select', $event)"
			/>
		</template>
	</div>
</template>

<style scoped>
.node { line-height: 1.45; }
.row {
	display: flex;
	align-items: baseline;
	gap: 0.6ch;
	padding: 0 1ch;
	white-space: nowrap;
}
.row.clickable { cursor: pointer; }
.row.clickable:hover { background: color-mix(in srgb, var(--color-text-primary) 8%, transparent); }
.row.on { background: color-mix(in srgb, var(--color-text-primary) 14%, transparent); }
.caret.hit { cursor: pointer; }
.branch, .caret { color: var(--color-text-secondary); }
.caret { width: 1ch; display: inline-block; }
.title { color: var(--color-text-primary); }
/* A page the top bar reaches and a page nothing reaches are the two states
   worth spotting at a glance; everything else is just a submenu. */
.title.tab { font-weight: 600; }
.title.locked { color: var(--color-text-secondary); }
.meta { color: var(--color-text-secondary); font-size: 0.85em; }
.badge {
	font-size: 0.72em;
	letter-spacing: 0.08em;
	padding: 0 0.5ch;
	border: 1px solid currentColor;
	border-radius: 2px;
}
.badge.tab { color: var(--color-text-primary); }
.badge.lock { color: var(--color-text-secondary); }
</style>
