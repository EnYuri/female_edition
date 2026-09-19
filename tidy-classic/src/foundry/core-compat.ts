/**
 * Shims for Foundry core APIs that moved between v13 and v14.
 *
 * Like `dnd5e-compat.ts`, everything here has to answer on BOTH versions: this fork
 * targets Foundry v13 as well as v14, so a deprecated API can be replaced only by
 * something that exists on both, or by a probe.
 */

/**
 * The UUID of `target` expressed relative to `relative`.
 *
 * v14 deprecated `ClientDocument#getRelativeUUID` in favour of
 * `foundry.utils.buildRelativeUuid`, which the deprecated method now simply forwards to —
 * so the two are identical in behaviour, and the only thing the old call buys is one
 * `logCompatibilityWarning` per invocation. That is not free here: the character sheet
 * resolves a relative UUID for every item on every `_prepareItems`, and every favourite
 * control asks again on every render, so the console filled with the same warning
 * hundreds of times per sheet open. Support is slated for removal in v16.
 *
 * v13 has no `foundry.utils.buildRelativeUuid`, hence the probe.
 */
export function buildRelativeUuid(target: any, relative: any): string {
  const build = (foundry.utils as any).buildRelativeUuid;
  return build ? build(target, relative) : target.getRelativeUUID(relative);
}

/**
 * The roll-mode keys this Foundry version accepts, as `{ value: labelKey }`.
 *
 * v14 deprecated `CONST.DICE_ROLL_MODES` (removal in v16) in favour of the configured
 * `CONFIG.ChatMessage.modes`, AND changed the values themselves: `publicroll`/`gmroll`/
 * `blindroll`/`selfroll` became `public`/`gm`/`blind`/`self`. Reading the old constant is
 * not merely noisy — every property on it is a getter that logs, so one settings pass
 * printed five warnings.
 *
 * The two vocabularies are not interchangeable. v14 accepts BOTH, because
 * `Roll._mapLegacyRollMode` translates the old names and passes anything else through; v13
 * accepts only the old ones. So the choice list is built from `CONFIG.ChatMessage.modes`
 * when that exists and from the legacy names otherwise — never from the deprecated
 * constant. `modes` also carries `ic`, which is a chat style rather than a roll visibility
 * and has never been offered here, so the list is restricted to the four roll modes.
 */
export function getRollModeChoices(): Record<string, string> {
  const modes = (CONFIG as any).ChatMessage?.modes;
  if (modes) {
    const choices: Record<string, string> = {};
    for (const key of ['public', 'gm', 'blind', 'self']) {
      if (modes[key]) choices[key] = modes[key].label;
    }
    if (Object.keys(choices).length) return choices;
  }
  return {
    publicroll: 'CHAT.RollPublic',
    gmroll: 'CHAT.RollPrivate',
    blindroll: 'CHAT.RollBlind',
    selfroll: 'CHAT.RollSelf',
  };
}

/** The first key of {@link getRollModeChoices} — the public/visible-to-all mode. */
export function getDefaultRollMode(): string {
  return Object.keys(getRollModeChoices())[0];
}

/**
 * A stored roll mode, translated into the vocabulary the running version accepts.
 *
 * A world setting saved under v13 holds `publicroll`; the same world opened on v14 offers
 * `public`. Both directions have to survive, because this fork is used on both and the
 * setting is handed straight to dnd5e as a `rollMode`, where a value from the other
 * vocabulary is silently not a roll mode at all.
 */
export function normalizeRollMode(value: unknown): string {
  const choices = getRollModeChoices();
  if (typeof value === 'string' && value in choices) return value;

  const toModern: Record<string, string> = {
    publicroll: 'public',
    gmroll: 'gm',
    blindroll: 'blind',
    selfroll: 'self',
  };
  const toLegacy: Record<string, string> = Object.fromEntries(
    Object.entries(toModern).map(([legacy, modern]) => [modern, legacy])
  );

  const translated =
    typeof value === 'string' ? (toModern[value] ?? toLegacy[value]) : undefined;
  return translated && translated in choices ? translated : getDefaultRollMode();
}

/**
 * One roll mode by its v14 name, spelled the way the running version accepts it.
 *
 * Call sites that want a FIXED mode (a blind perception roll, say) should not have to know
 * which vocabulary is in play; `getRollMode('blind')` answers `blind` on v14 and
 * `blindroll` on v13.
 */
export function getRollMode(mode: 'public' | 'gm' | 'blind' | 'self'): string {
  return normalizeRollMode(mode);
}

/**
 * The `ForcedDeletion` operator class, or `undefined` on a version that has none.
 *
 * v14 replaced the `{"-=key": null}` "special key" convention with real operator objects
 * (`foundry.data.operators.ForcedDeletion`, also reachable as the `_del` global). The old
 * spelling still works, but `_migrateDeletionKey` (`common/utils/helpers.mjs`) and the two
 * field-level equivalents in `common/data/fields.mjs` each log a compatibility warning for
 * it, and support ends in **v16**. v13 has no operators at all, so the legacy spelling is
 * the only one available there — hence the probe rather than a rewrite.
 */
function getForcedDeletion(): any {
  return (foundry as any).data?.operators?.ForcedDeletion;
}

/**
 * Marks `key` for deletion inside an object that is submitted as a whole value.
 *
 * Used where the deleted key lives inside a nested object being handed to `update()`
 * (a flag whose value is a map, say), not at the top level of the update itself — the
 * dotted-path form is {@link buildDeletion}.
 */
export function markDeleted(container: Record<string, any>, key: string): void {
  const ForcedDeletion = getForcedDeletion();
  if (ForcedDeletion) container[key] = new ForcedDeletion();
  else container[`-=${key}`] = null;
}

/**
 * An update payload that deletes the value at a dotted `path`.
 *
 * Merge it into the update rather than assigning a key, because the key itself differs
 * between versions: v13 needs the `-=` prefix on the final segment and v14 does not.
 */
export function buildDeletion(path: string): Record<string, unknown> {
  const segments = path.split('.');
  const last = segments.pop()!;
  const ForcedDeletion = getForcedDeletion();
  return ForcedDeletion
    ? { [[...segments, last].join('.')]: new ForcedDeletion() }
    : { [[...segments, `-=${last}`].join('.')]: null };
}

/**
 * The label for an ActiveEffect change's operation, as a localization key or literal.
 *
 * v14 replaced the numeric `change.mode` with the string `change.type` and deprecated
 * BOTH the property and `CONST.ACTIVE_EFFECT_MODES` (removal in v16) — every read of
 * either logs a compatibility warning. Labels moved to the `ActiveEffect.CHANGE_TYPES`
 * registry (`{ value, label, defaultPriority, handler, render }` per type), which also
 * folds in system/module-registered types from `CONFIG.ActiveEffect.changeTypes`, so
 * consulting it is strictly better than translating a name ourselves.
 *
 * On v13 neither the registry nor `change.type` exists, so the numeric-mode path is the
 * only one available there — `CONST.ACTIVE_EFFECT_MODES` is not deprecated on v13.
 *
 * Returns a localization key (core types resolve to `EFFECT.CHANGES.TYPES.*` on v14 and
 * `EFFECT.MODE_*` on v13), the registered literal label for non-core types, or the raw
 * type string when nothing better exists. `undefined` when the change has neither a
 * type nor a mode the running version understands.
 */
export function getEffectChangeTypeLabel(change: {
  type?: string;
  mode?: number;
}): string | undefined {
  const registry = ((CONFIG as any).ActiveEffect?.documentClass?.CHANGE_TYPES ??
    (globalThis as any).ActiveEffect?.CHANGE_TYPES) as
    | Record<string, { label?: string }>
    | undefined;

  if (registry) {
    if (typeof change?.type !== 'string' || !change.type) return undefined;
    return registry[change.type]?.label ?? change.type;
  }

  const modes = (CONST as any).ACTIVE_EFFECT_MODES as
    | Record<string, number>
    | undefined;
  if (!modes || typeof change?.mode !== 'number') return undefined;
  const name = Object.keys(modes).find((key) => modes[key] === change.mode);
  return name ? `EFFECT.MODE_${name}` : undefined;
}

/**
 * The localization key for an ActiveEffect change-table column header.
 *
 * v14 deleted `EFFECT.ChangeKey`/`EFFECT.ChangeMode`/`EFFECT.ChangeValue` in favour of
 * `EFFECT.FIELDS.changes.element.{key,type,value}.label`, so the old keys render as raw
 * strings there. Probed through `game.i18n.has` rather than a version check so any
 * backport of the new keys self-selects.
 */
export function getEffectChangeFieldLabelKey(
  field: 'key' | 'type' | 'value'
): string {
  const modern = `EFFECT.FIELDS.changes.element.${field}.label`;
  if (game.i18n.has(modern)) return modern;
  return {
    key: 'EFFECT.ChangeKey',
    type: 'EFFECT.ChangeMode',
    value: 'EFFECT.ChangeValue',
  }[field];
}

/**
 * Mirrors v13 context-menu entry keys onto their v14 names, in place.
 *
 * v14 deprecated `ContextMenuEntry#name`/`#condition`/`#callback` in favour of
 * `#label`/`#visible`/`#onClick` (removal in v16) and logs a compatibility warning
 * whenever a legacy key is found WITHOUT its modern counterpart — `once` dedupes it
 * to one line per key per session, but the key list here is long. Both vocabularies
 * still work, and the fork targets v13, which reads ONLY the old names — so entries
 * keep the legacy key AND get the modern one mirrored rather than being renamed.
 *
 * `callback(target, event)` and `onClick(event, target)` take their arguments in
 * opposite orders, hence the forwarding wrapper rather than a plain alias. Every
 * FloatingContextMenu in this fork passes `jQuery: false`, so the wrapped callback
 * always receives the raw HTMLElement it would have gotten from core.
 */
export function normalizeContextMenuEntries(entries: any[] | undefined): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    if (!entry) continue;
    if ('condition' in entry && !('visible' in entry)) {
      entry.visible = entry.condition;
    }
    if ('name' in entry && !('label' in entry)) entry.label = entry.name;
    if ('callback' in entry && !('onClick' in entry)) {
      const callback = entry.callback;
      entry.onClick = (event: any, target: any) => callback(target, event);
    }
  }
}

/**
 * Renders a Handlebars template file, through whichever accessor this version exposes.
 *
 * v13 moved `renderTemplate` (and the rest of the Handlebars helpers) under
 * `foundry.applications.handlebars`; the bare global is still there but every read of it
 * logs a compatibility warning, and it is **removed in v15**. v13 already has the
 * namespaced form, so the probe never falls back on a supported version — the global is
 * kept only as a last resort.
 */
export async function renderHandlebarsTemplate(
  path: string,
  data: any
): Promise<string> {
  const render =
    (foundry as any).applications?.handlebars?.renderTemplate ??
    (globalThis as any).renderTemplate;
  return await render(path, data);
}
