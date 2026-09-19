import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import path from 'node:path';

/**
 * Build for the Classic-layout Tidy fork.
 *
 * The output is COMMITTED (`dist/`) so Foundry still loads female_edition with no build
 * step — node is a development-time requirement only, which is the compromise that keeps
 * CLAUDE.md's "files served directly to Foundry" rule true for users.
 *
 * Library mode with a fixed file name: Foundry's module.json needs a stable path, and
 * hashed asset names would make every rebuild a manifest edit.
 */
export default defineConfig({
  plugins: [svelte({ emitCss: true })],
  resolve: {
    alias: [
      // Upstream imports itself as `src/...` in a good number of files.
      //
      // This is the ENTRIES form with an anchored regex on purpose. The object form
      // (`{ src: ... }`) left some of these specifiers unresolved, and an unaliased
      // `src/...` id never reaches vite-plugin-svelte's filter — Rollup then hands the
      // raw `.svelte` text to its JS parser and reports "Expression expected (Note that
      // you need plugins to import files that are not JavaScript)", which reads like a
      // broken component but is really a resolution miss.
      { find: /^src\//, replacement: path.resolve(__dirname, 'src') + '/' },
      // Ambient module upstream declared in a .d.ts. Every use is type-only, but esbuild
      // leaves a bare side-effect import behind after stripping the type specifiers, so it
      // still has to resolve somewhere.
      {
        find: 'foundry.data.fields',
        replacement: path.resolve(__dirname, 'src/foundry/foundry.data.fields.ts'),
      },
      // Types-only subpath of svelte (`exports["./elements"]` has no runtime entry), same
      // leftover-bare-import problem.
      {
        find: 'svelte/elements',
        replacement: path.resolve(__dirname, 'src/shims/svelte-elements.ts'),
      },
    ],
  },
  // `public/` holds tidy's own fonts/images/rpg-awesome/templates and is served straight
  // out of the module directory; the recovered global stylesheet points at `../public/`.
  // Letting Vite copy it into dist/ would ship a second copy nothing references.
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 'hidden' emits the .map files for local debugging but omits the trailing
    // `//# sourceMappingURL=` comment. The maps are export-ignore'd (the js one alone
    // is larger than the bundle), so a plain `true` would ship a reference to a file
    // that is not in the zip — a 404 in every user's devtools. Attach them manually
    // when debugging a build locally.
    sourcemap: 'hidden',
    // Foundry is evergreen-Chromium only; no need to down-level.
    target: 'es2022',
    minify: false,
    lib: {
      entry: path.resolve(__dirname, 'src/main.svelte.ts'),
      formats: ['es'],
      fileName: () => 'tidy-classic.js',
    },
    rollupOptions: {
      output: {
        assetFileNames: (info) =>
          info.name && info.name.endsWith('.css')
            ? 'tidy-classic.css'
            : 'assets/[name][extname]',
      },
    },
  },
});
