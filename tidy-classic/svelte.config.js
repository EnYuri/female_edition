import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  // `script: true` is REQUIRED, not a default we are restating.
  //
  // Since vite-plugin-svelte 4, `vitePreprocess()` leaves `<script lang="ts">` to Svelte's
  // own TypeScript handling and only preprocesses `<style>`. Svelte's native stripping
  // removes type ANNOTATIONS but leaves the optional marker, so
  // `function f(colors?: T[])` compiles to `function f(colors?)` — which is not valid
  // JavaScript. Rollup then reports "Expected ',', got '?' (Note that you need plugins to
  // import files that are not JavaScript)", which looks like a plugin/resolution problem
  // and is really a TS-stripping gap. Routing scripts through esbuild fixes it.
  //
  // This does NOT cover TypeScript written in MARKUP (typed `{#snippet}` parameters):
  // esbuild only sees the script block. Those had to be edited in the sources instead.
  preprocess: vitePreprocess({ script: true }),
  compilerOptions: {
    // Upstream 12.5.5 is a Svelte 5 runes codebase.
    runes: true,
  },
};
