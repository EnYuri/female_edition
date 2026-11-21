/** Quick Insert normally registers through the official module's manifest entry.
 * With only Classic installed, use its loaded dnd5e integration and normal submit handler.
 */
export function registerClassicQuickInsert(api) {
  if (!game.modules.get('quick-insert')?.active || game.modules.has('tidy5e-sheet') ||
      game.modules.get('tidy5e-sheet-kgar')?.api) return;

  api.config.actorItem.registerSectionCommands([{
    tooltip: 'Quick Insert',
    iconClass: 'fas fa-search',
    enabled: ({ actor }) => actor.isOwner && ['character', 'npc', 'vehicle'].includes(actor.type) &&
      Boolean(globalThis.QuickInsert?.systemIntegration?.Dnd5eSheetContext) &&
      game.settings.get('quick-insert', 'filtersSheetsEnabled'),
    execute: openClassicQuickInsert,
  }]);
}

/** Use the section's complete type list for Classic, including commands mirrored
 * from official Tidy. Its upstream callback only accepts a single dataset.type. */
export function openClassicQuickInsert({ actor, event, section }) {
  const quickInsert = globalThis.QuickInsert;
  const Context = quickInsert?.systemIntegration?.Dnd5eSheetContext;
  const anchor = event.currentTarget;
  const sheet = foundry.applications.instances.get(anchor.closest('.application')?.id);
  if (!Context || !sheet?.isEditable || sheet.document !== actor) return;

  const { type, system } = quickInsertSection(section, actor).dataset ?? {};
  const customTypes = section.custom?.creationItemTypes;
  const types = customTypes?.length ? customTypes : type ? [type] : undefined;
  const position = globalThis.jQuery?.(anchor) ?? { 0: anchor, get: () => [anchor] };
  quickInsert.open(new Context(sheet, position, types, system));
}

/** Quick Insert submits a plain object with no event type. Chromium can report
 * dropEffect "none" on its new DataTransfer even after the widget sets "copy".
 * Only native events participate in dnd5e's last canvas drag/drop effect.
 */
export function classicActorDropBehavior(sheet, event, data) {
  if (event.type || !event.dataTransfer || data?.type !== 'Item' || !data.uuid ||
      !game.modules.get('quick-insert')?.active ||
      !event.target?.matches?.('[data-tooltip="Quick Insert"], [title="Quick Insert"], .quick-insert-link')) {
    return sheet._dropBehavior(event);
  }
  return sheet._allowedDropBehaviors(event, data).has('copy') ? 'copy' : 'none';
}
/** Classic stores creation data as dotted update paths. Quick Insert reads search
 * filters from dataset.system and compares spell levels as numbers or ranges. */
export function quickInsertSection(section, actor) {
  const data = section.dataset ?? {};
  const type = data.type ?? (section.custom?.creationItemTypes?.length === 1
    ? section.custom.creationItemTypes[0] : undefined);
  if (type !== 'spell') return section;
  const level = data['system.level'];
  let system = data.system;
  if (!system && /^spell[0-9]+$/.test(section.slot) && Number.isInteger(level)) {
    system = { level };
  } else if (!system && section.slot === 'pact') {
    const max = actor.system?.spells?.pact?.level;
    if (max > 0) system = { level: { min: 1, max } };
  }
  return { ...section, dataset: { ...data, type, system } };
}
