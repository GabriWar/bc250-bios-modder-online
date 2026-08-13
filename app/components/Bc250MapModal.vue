<script setup lang="ts">
import type { BiosMap, MapNode } from "~/utils/bc250/map.ts";

const props = defineProps<{ map: BiosMap }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();

const selected = ref<MapNode | null>(props.map.tree[0] ?? null);
// A command, not a level: {open, n}. A single counter cannot express "collapse"
// after one "expand", because it lands back on zero and no branch fires.
const openAll = ref({ open: false, n: 0 });
const expandAll = () => (openAll.value = { open: true, n: openAll.value.n + 1 });
const collapseAll = () => (openAll.value = { open: false, n: openAll.value.n + 1 });
const filter = ref("");

// Escape closes it, because a full-screen overlay you can only leave by finding
// the right button is the kind of thing people resize the window to escape.
function onKey(e: KeyboardEvent) {
	if (e.key === "Escape") emit("close");
}
onMounted(() => {
	document.addEventListener("keydown", onKey);
	document.body.style.overflow = "hidden";
});
onBeforeUnmount(() => {
	document.removeEventListener("keydown", onKey);
	document.body.style.overflow = "";
});

// The parser names item kinds in English because that is what the IFR calls
// them; the label is a separate concern from the identifier.
const KIND_KEY: Record<string, string> = {
	heading: "mapKindHeading",
	info: "mapKindInfo",
	link: "mapKindLink",
	list: "mapKindList",
	number: "mapKindNumber",
	checkbox: "mapKindCheckbox",
	password: "mapKindPassword",
	action: "mapKindAction",
	"text field": "mapKindTextField",
	option: "mapKindOption",
};
const kindLabel = (kind: string) => (KIND_KEY[kind] ? t(`bc250.${KIND_KEY[kind]}`) : kind);

const hex = (n: number) => "0x" + n.toString(16);

const totals = computed(() => {
	let pages = 0;
	let questions = 0;
	let options = 0;
	for (const fs of props.map.formsets) {
		pages += fs.forms.length;
		for (const f of fs.forms)
			for (const i of f.items) {
				if (i.questionId !== undefined) questions++;
				options += i.options?.length ?? 0;
			}
	}
	return { pages, questions, options };
});

// Filtering walks the whole tree and keeps a branch when the branch itself or
// anything under it matches, so searching for a leaf still shows you the path
// that reaches it.
function prune(node: MapNode, needle: string): MapNode | null {
	const hit =
		(node.title ?? "").toLowerCase().includes(needle) ||
		node.items.some((i) => (i.prompt ?? "").toLowerCase().includes(needle));
	const kids = node.children.map((c) => prune(c, needle)).filter((c): c is MapNode => c !== null);
	if (!hit && !kids.length) return null;
	return { ...node, children: kids };
}

const tree = computed(() => {
	const needle = filter.value.trim().toLowerCase();
	if (!needle) return props.map.tree;
	return props.map.tree.map((r) => prune(r, needle)).filter((r): r is MapNode => r !== null);
});

// Two shapes for two uses: the text is for reading and diffing, the JSON is for
// feeding something else. Built once and revoked on the way out -- a computed
// that calls createObjectURL mints a new blob on every render and leaks them.
const asText = () => {
	const out: string[] = [];
	for (const fs of props.map.formsets) {
		out.push(`=== ${fs.title ?? fs.guid}  [${fs.module ?? "?"}] ===`);
		for (const v of fs.varstores) out.push(`  varstore 0x${v.id.toString(16)} ${v.size}B ${v.name}`);
		for (const f of fs.forms) {
			const mark = f.isTab ? "TAB " : f.reachable ? "    " : "LOCK";
			out.push(`  ${mark} form ${f.id} (0x${f.id.toString(16)})  ${f.title ?? ""}`);
			for (const i of f.items) {
				if (i.kind === "link") {
					out.push(`        -> form ${i.targetForm}  ${i.prompt ?? ""}`);
					continue;
				}
				const id = i.questionId !== undefined ? `  [id 0x${i.questionId.toString(16)}]` : "";
				out.push(`        ${i.kind.padEnd(10)} ${i.prompt ?? ""}${id}`);
				if (i.help) out.push(`                   ${i.help}`);
				if (i.varStoreId !== undefined)
					out.push(
						`                   varstore 0x${i.varStoreId.toString(16)}` +
							` + 0x${(i.varStoreOffset ?? 0).toString(16)}` +
							(i.max !== undefined ? `  ${i.min}..${i.max}` : ""),
					);
				for (const o of i.options ?? [])
					out.push(`                   = ${o.text ?? ""} (${o.value})${o.isDefault ? " [default]" : ""}`);
			}
		}
		out.push("");
	}
	return out.join("\n");
};

const blobUrl = (data: string, type: string) => URL.createObjectURL(new Blob([data], { type }));
const txtUrl = ref("");
const jsonUrl = ref("");
onMounted(() => {
	txtUrl.value = blobUrl(asText(), "text/plain");
	jsonUrl.value = blobUrl(JSON.stringify(props.map, null, 1), "application/json");
});
onBeforeUnmount(() => {
	if (txtUrl.value) URL.revokeObjectURL(txtUrl.value);
	if (jsonUrl.value) URL.revokeObjectURL(jsonUrl.value);
});

const detailItems = computed(() => selected.value?.items ?? []);

// The three things a page holds, counted separately: a page can be all links
// and no questions, or fifteen rows of read-only information and one question.
// Showing a single number for any of those misleads.
const counts = computed(() => {
	const items = detailItems.value;
	return {
		questions: items.filter((i) => i.questionId !== undefined).length,
		info: items.filter((i) => i.kind === "heading" || i.kind === "info").length,
		links: items.filter((i) => i.kind === "link").length,
	};
});
</script>

<template>
	<Teleport to="body">
	<div class="overlay" data-testid="map-modal" data-lenis-prevent @click.self="emit('close')">
		<div class="sheet">
			<header>
				<button class="link close" data-testid="map-close" @click="emit('close')">
					{{ t("bc250.mapClose") }}
				</button>
				<span class="head-title">{{ t("bc250.mapTitle") }}</span>
				<a class="link" :href="txtUrl" download="bc250-menu-map.txt" data-testid="map-txt">
					{{ t("bc250.mapExportTxt") }}
				</a>
				<a class="link" :href="jsonUrl" download="bc250-menu-map.json" data-testid="map-json">
					{{ t("bc250.mapExportJson") }}
				</a>
				<span class="head-meta">
					{{ map.formsets.length }} formsets · {{ totals.pages }} {{ t("bc250.mapPages") }} ·
					{{ totals.questions }} {{ t("bc250.mapQuestions") }} ·
					{{ totals.options }} {{ t("bc250.mapValues") }} ·
					{{ map.tabs.length }} {{ t("bc250.mapTabsShort") }} ·
					{{ map.locked.length }} {{ t("bc250.mapLockedShort") }}
				</span>
			</header>

			<div class="body">
				<aside>
					<div class="tools">
						<input v-model="filter" class="search" :placeholder="t('bc250.mapFilter')" />
					</div>
					<div class="tools">
						<button class="link" data-testid="map-expand" @click="expandAll">{{ t("bc250.mapExpandAll") }}</button>
						<button class="link" data-testid="map-collapse" @click="collapseAll">{{ t("bc250.mapCollapseAll") }}</button>
					</div>
					<div class="tree" data-lenis-prevent>
						<Bc250MapNode
							v-for="root in tree"
							:key="root.id"
							:node="root"
							:open-all="openAll"
							:selected="selected?.id"
							@select="selected = $event"
						/>
					</div>
				</aside>

				<section class="detail" data-lenis-prevent>
					<template v-if="selected">
						<h3>
							{{ selected.title ?? `form ${selected.id}` }}
							<span v-if="selected.isTab" class="badge tab">{{ t("bc250.mapBadgeTab") }}</span>
							<span v-if="selected.locked" class="badge lock">{{ t("bc250.mapBadgeLock") }}</span>
						</h3>
						<p class="sub">
							{{ selected.formset }} · {{ t("bc250.mapFormId") }} {{ hex(selected.id) }} ·
							{{ counts.questions }} {{ t("bc250.mapQuestions") }} ·
							{{ counts.info }} {{ t("bc250.mapInfo") }} ·
							{{ counts.links }} {{ t("bc250.mapLinks") }}
						</p>
						<p v-if="selected.locked" class="warn-note">{{ t("bc250.mapLockedNote") }}</p>

						<div
							v-for="(item, i) in detailItems"
							:key="i"
							class="item"
							:class="[
								item.kind,
								item.questionId !== undefined ? 'is-question' : item.kind === 'link' ? 'is-link' : 'is-info',
							]"
						>
							<div class="item-head">
								<span class="kind">{{ kindLabel(item.kind) }}</span>
								<span class="prompt">{{ item.prompt || "" }}</span>
								<span v-if="item.questionId !== undefined" class="id">
									{{ t("bc250.mapId") }} {{ hex(item.questionId) }}
								</span>
							</div>
							<p v-if="item.help" class="help">{{ item.help }}</p>
							<p v-if="item.varStoreId !== undefined" class="store">
								{{ t("bc250.mapVarstore") }} {{ hex(item.varStoreId) }} + {{ hex(item.varStoreOffset ?? 0) }}
								<template v-if="item.width">
									· {{ item.width }} {{ t("bc250.mapBytes", item.width) }}
								</template>
								<template v-if="item.max !== undefined"> · {{ item.min }}..{{ item.max }}</template>
							</p>
							<p v-if="item.targetForm !== undefined" class="store">
								→ form {{ hex(item.targetForm) }}
							</p>
							<ul v-if="item.options?.length" class="opts">
								<li v-for="(o, j) in item.options" :key="j" :class="{ def: o.isDefault }">
									{{ o.text || "—" }} <span class="val">{{ o.value }}</span>
									<span v-if="o.isDefault" class="def-tag">{{ t("bc250.mapDefault") }}</span>
								</li>
							</ul>
						</div>
					</template>
					<p v-else class="sub">{{ t("bc250.mapPick") }}</p>
				</section>
			</div>
		</div>
	</div>
	</Teleport>
</template>

<style scoped>
/* .link lives in the page's scoped styles, so it does not reach in here and the
   buttons render as browser defaults. */
.link {
	background: none;
	border: none;
	color: var(--color-text-primary);
	font-family: inherit;
	font-size: 1rem;
	cursor: pointer;
	padding: 0;
	text-decoration: none;
}
.link:hover { color: var(--color-text-secondary); }
.close { margin-right: 0.4rem; }
.overlay {
	position: fixed;
	inset: 0;
	z-index: 200;
	background: color-mix(in srgb, var(--color-background) 82%, black);
	display: flex;
	padding: 0;
}
.sheet {
	flex: 1;
	display: flex;
	flex-direction: column;
	min-height: 0;
	background: var(--color-background);
	border: 0;
}
header {
	display: flex;
	align-items: baseline;
	gap: 1rem;
	flex-wrap: wrap;
	padding: 0.6rem 1rem;
	border-bottom: 1px solid var(--color-border);
}
.head-title { font-weight: 600; }
.head-meta { color: var(--color-text-secondary); font-size: 0.85em; flex: 1; }
.body { display: flex; flex: 1; min-height: 0; }
aside {
	width: 44ch;
	min-width: 28ch;
	display: flex;
	flex-direction: column;
	border-right: 1px solid var(--color-border);
	min-height: 0;
}
.tools {
	display: flex;
	gap: 0.5rem;
	padding: 0.5rem;
	border-bottom: 1px solid var(--color-border);
	flex-wrap: wrap;
}
.search {
	flex: 1;
	min-width: 12ch;
	background: transparent;
	border: 1px solid var(--color-border);
	color: inherit;
	font: inherit;
	padding: 0.15rem 0.5ch;
}
.tree { overflow: auto; overscroll-behavior: contain; flex: 1; padding: 0.4rem 0; }
.detail { flex: 1; overflow: auto; overscroll-behavior: contain; padding: 0.8rem 1.2rem; min-width: 0; }
h3 { margin: 0 0 0.2rem; display: flex; align-items: center; gap: 0.5rem; }
.sub { color: var(--color-text-secondary); margin: 0 0 0.8rem; font-size: 0.9em; }
/* A locked page is the reason this view exists, so it says so rather than
   leaving the badge to carry the whole meaning. */
.warn-note {
	margin: 0 0 0.8rem;
	padding: 0.3rem 0.6rem;
	border-left: 2px solid var(--color-text-secondary);
	color: var(--color-text-secondary);
	font-size: 0.9em;
}
.item { padding: 0.45rem 0; border-top: 1px solid var(--color-border); }
/* Three kinds of row, and the eye should sort them without reading: an answerable
   question, a line of read-only information, and a door to another page. */
.item.is-question { border-left: 2px solid var(--color-text-primary); padding-left: 0.6ch; }
.item.is-link { border-left: 2px solid var(--color-text-secondary); padding-left: 0.6ch; }
.item.is-info { opacity: 0.75; }
.item-head { display: flex; gap: 0.6rem; align-items: baseline; flex-wrap: wrap; }
.kind {
	color: var(--color-text-secondary);
	font-size: 0.78em;
	min-width: 8ch;
	letter-spacing: 0.04em;
}
.prompt { flex: 1; min-width: 12ch; }
.id { color: var(--color-text-secondary); font-size: 0.8em; }
.help { margin: 0.15rem 0 0 8.6ch; color: var(--color-text-secondary); font-size: 0.88em; }
.store { margin: 0.15rem 0 0 8.6ch; color: var(--color-text-secondary); font-size: 0.8em; }
.opts { margin: 0.25rem 0 0 8.6ch; padding: 0; list-style: none; }
.opts li {
	color: var(--color-text-secondary);
	font-size: 0.88em;
	display: flex;
	gap: 0.8ch;
	align-items: baseline;
}
.opt-text { min-width: 22ch; }
.opts li.def { color: var(--color-text-primary); }
.val { opacity: 0.7; font-variant-numeric: tabular-nums; }
.def-tag { font-size: 0.75em; letter-spacing: 0.06em; opacity: 0.8; }
.badge {
	font-size: 0.7em;
	letter-spacing: 0.08em;
	padding: 0 0.5ch;
	border: 1px solid currentColor;
	border-radius: 2px;
	color: var(--color-text-secondary);
}
@media (max-width: 900px) {
	.body { flex-direction: column; }
	aside { width: auto; border-right: 0; border-bottom: 1px solid var(--color-border); max-height: 40%; }
}
</style>
