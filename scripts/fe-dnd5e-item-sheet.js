import { feRegisterSetting } from "./fe-settings-data.js";
/**
 * fe-dnd5e-item-sheet.js — two opt-in fixes for dnd5e's OWN item sheet.
 *
 * Both are guarded on `CONFIG?.DND5E` and are pure presentation: nothing here changes what
 * is stored, only how the sheet offers it.
 *
 * 1. RARITY AS A SINGLE DROPDOWN (`ceDnd5eItemRaritySelect`).
 *    dnd5e 6.0 replaced `system.rarity` (one string) with `system.rarities`, a
 *    `SetField(StringField)` — an item may now carry several. `PhysicalItemTemplate#
 *    physicalItemSheetFields` hands that field to `templates/items/header.hbs`, which
 *    renders it with `formInput`; `SetField#_toInput` sees `options` and returns
 *    `createMultiSelectInput(...)`, i.e. the tag widget where you pick from a dropdown to
 *    ADD a tag and then remove tags individually. For a table that only ever assigns one
 *    rarity that is strictly more clicks, and it no longer shows the current value as the
 *    closed state of a select. This swaps the widget for a plain single `<select>` that
 *    writes `{"system.rarities": [key]}` (or `[]` for none).
 *
 *    The `<select>` deliberately carries NO `name`, and its change handler stops
 *    propagation: dnd5e's sheet is `submitOnChange`, and an unnamed control is skipped by
 *    `FormDataExtended` entirely, so `system.rarities` is simply absent from the submit and
 *    stays untouched — the explicit `item.update()` is the only writer. Letting the event
 *    reach the form as well would run a second, redundant update and re-render mid-flight.
 *
 *    It is a no-op on dnd5e <= 5.x: there `system.rarity` is already a single select, so
 *    the presence of the `rarities` schema field is the probe (never the system version —
 *    the schema is the thing that decides which key is accepted).
 *
 * 2. FLAT ITEM SHEET (`ceDnd5eItemSheetFlat`). dnd5e paints every application with
 *    `background: var(--dnd5e-application-background)`, a multi-layer parchment/denim
 *    texture, and stamps a 150px banner image over the item sheet header through
 *    `.dnd5e2.sheet.item::before`. styles/fe-dnd5e-compat.css strips the IMAGE layers only
 *    (`background-image: none`), never the colour: the colour rides on the same shorthand,
 *    so whatever dnd5e resolved for the active theme survives and the sheet stays readable
 *    in both light and dark without us guessing a palette.
 */

import { S, FE_DEFAULTS, feSetting } from "./fe-chat-enhance.js";

/** Body class that opens the flat-item-sheet rules in styles/fe-dnd5e-compat.css. */
const FE_D5E_ITEM_FLAT_CLASS = "fe-dnd5e-item-flat";

/** Marks an `<li>` we have already converted, so a re-render does not stack selects. */
const FE_D5E_RARITY_MARK = "feD5eRarity";

function feD5eIsDnd5e() {
  return !!CONFIG?.DND5E;
}

// feSetting, not game.settings.get: it consults the GM-priority override store first, so a
// GM-forced value is correct even before it syncs into each client's game.settings.
function feD5eRead(key) {
  try { return !!(feSetting(key) ?? FE_DEFAULTS[key]); }
  catch { return !!FE_DEFAULTS[key]; }
}

/** @param {boolean} enabled */
function feD5eApplyFlatItemSheet(enabled) {
  document.body?.classList.toggle(FE_D5E_ITEM_FLAT_CLASS, !!enabled);
}

/**
 * Replace the rarity tag widget on one rendered item sheet with a single `<select>`.
 * @param {ApplicationV2} app
 * @param {HTMLElement} element  The sheet's root element.
 */
function feD5eApplyRaritySelect(app, element) {
  if ( !feD5eRead(S.DND5E_ITEM_RARITY_SELECT) ) return;

  const item = app?.document;
  // dnd5e >= 6.0 only. On 5.x `system.rarity` is already a single select.
  if ( !item?.system?.schema?.fields?.rarities ) return;
  if ( !app.isEditable ) return;

  const host = element?.querySelector?.("li.item-rarity");
  // Not editable / details concealed renders a plain <span> label instead; leave it alone.
  if ( !host || host.dataset[FE_D5E_RARITY_MARK] || !host.querySelector("multi-select") ) return;

  const select = document.createElement("select");
  // Deliberately no `name` attribute — see the header note on submitOnChange.
  select.className = "fe-item-rarity-select";

  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = game.i18n.localize("DND5E.Rarity");
  select.append(blank);

  for ( const [key, label] of Object.entries(CONFIG.DND5E.itemRarity ?? {}) ) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = game.i18n.localize(label);
    select.append(option);
  }

  // Read from the live document: on 6.0 `system.rarity` survives only as a prototype getter
  // over the set, which no structured copy of `system` carries along.
  select.value = item.system.rarities?.first?.() ?? "";

  select.addEventListener("change", (event) => {
    event.stopPropagation();
    const value = select.value;
    item.update({ "system.rarities": value ? [value] : [] });
  });

  host.dataset[FE_D5E_RARITY_MARK] = "1";
  host.replaceChildren(select);
}

Hooks.once("init", () => {
  if ( !feD5eIsDnd5e() ) return;

  feRegisterSetting(S.DND5E_ITEM_RARITY_SELECT);
  feRegisterSetting(S.DND5E_ITEM_SHEET_FLAT, (value) => feD5eApplyFlatItemSheet(!!value));

  // The hook is installed unconditionally and reads the setting per render, so toggling it
  // needs no reload — the next time a sheet renders it takes the current answer.
  // `renderItemSheet5e` also fires for every subclass: ApplicationV2 dispatches the render
  // hook for each class in the prototype chain (application.mjs #callHooks).
  Hooks.on("renderItemSheet5e", (app, element) => {
    try { feD5eApplyRaritySelect(app, element); }
    catch ( err ) { console.warn("female_edition | dnd5e rarity select", err); }
  });
});

// `setup`, not `ready`: a stuck canvas can keep `ready` from ever firing, and this only
// reads a setting and writes a body class. Re-applied at `ready` because GM-priority
// overrides are not loaded yet at `setup`; both writes are idempotent.
Hooks.once("setup", () => {
  if ( feD5eIsDnd5e() ) feD5eApplyFlatItemSheet(feD5eRead(S.DND5E_ITEM_SHEET_FLAT));
});
Hooks.once("ready", () => {
  if ( feD5eIsDnd5e() ) feD5eApplyFlatItemSheet(feD5eRead(S.DND5E_ITEM_SHEET_FLAT));
});
