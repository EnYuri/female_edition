import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../tidy-classic/src/', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

// Both modules once inserted <style id="tidy5e-sheets-quadrone-theme-settings"> and
// shared the world-rule identifier, so this fork's world theme wiped tidy 14's.
test('Quadrone theme stylesheet is the fork\'s own, and world rules yield to official Tidy', () => {
  const theme = read('theme/theme-quadrone.svelte.ts');
  assert.match(theme, /static readonly tagId = 'fe-tidy-classic-quadrone-theme-settings';/);
  const apply = theme.slice(theme.indexOf('static applyCurrentThemeSettingsToStylesheet('));
  assert.match(apply.slice(0, 700),
    /if \(!options\.doc && !options\.idOverride && this\.officialTidyOwnsWorldTheme\(\)\) \{\s*return;/);
  assert.doesNotMatch(read('utils/DebugTools.ts'), /'tidy5e-sheets-quadrone-theme-settings'/);
});

// core's keybindings.register() is a Map.set, so a shared action id silently overwrites.
test('no Classic keybinding registers under the official tidy5e-sheet namespace', () => {
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
  const offenders = walk(root)
    .filter((p) => /\.(ts|js|svelte)$/.test(p))
    .filter((p) => /keybindings\.register\(\s*CONSTANTS\.MODULE_ID\b/.test(readFileSync(p, 'utf8')));
  assert.deepEqual(offenders, []);
  assert.match(read('keybindings/keybind-init.ts'),
    /keybindings\.register\(CONSTANTS\.SETTINGS_NAMESPACE, `tidyClassic-\$\{registrationKey\}`/);
});

// The only runtime hook both bundles fired AND subscribed to; tidy 14's Quadrone theme
// dialog repainted open Classic sheets through it.
test('the Classic theme-change hook is private to the fork', () => {
  const hooks = read('foundry/TidyHooks.ts');
  assert.match(hooks, /static tidy5eSheetsThemeSettingsChangedHook =\s*'female_edition\.tidyClassicThemeSettingsChanged';/);
});
