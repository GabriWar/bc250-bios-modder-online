export default defineNuxtConfig({
	compatibilityDate: "2026-08-11",
	modules: ["@nuxtjs/i18n"],
	css: ["~/assets/css/theme.css"],
	ssr: true,
	i18n: {
		locales: [
			{ code: "en", iso: "en-US", name: "English", file: "en.json" },
			{ code: "pt-BR", iso: "pt-BR", name: "Português (BR)", file: "pt-BR.json" },
		],
		defaultLocale: "en",
		langDir: "locales",
		strategy: "no_prefix",
		detectBrowserLanguage: {
			useCookie: true,
			cookieKey: "i18n_redirected",
			redirectOn: "root",
		},
	},
	// lzma-wasm ships a wasm binary that Vite must not try to prebundle
	vite: { optimizeDeps: { exclude: ["lzma-wasm"] } },
});
