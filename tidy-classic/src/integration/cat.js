/** CAT flags may outlive the module in a world's stored documents. */
export function isCatHiddenActivity(activity) {
  return Boolean(activity?.flags?.cat?.hidden && game.modules.get('cat')?.active);
}

export function hideCatActivityOnActor(activity) {
  return isCatHiddenActivity(activity) && game.settings.get('cat', 'hideActivitiesOnActorSheet');
}

/** Match the sheets and status colors supported by CAT's Tidy integration. */
export function updateCatKitStatus(document, element) {
  if (!game.modules.get('cat')?.active || !element?.classList.contains('classic')) return;
  const item = document.documentName === 'Item';
  if (!item && !(document.documentName === 'Actor' && document.type === 'character')) return;
  const button = element.querySelector(item ? '.window-header .cat-medkit-item' : '.window-header .cat-medkit-actor');
  const cat = globalThis.cat;
  const codes = cat?.lib?.constants?.automationStatus;
  const colors = cat?.lib?.constants?.MEDKIT_STATUSES;
  if (!button || !codes || !colors || !cat.utils?.automationUtils?.getAutomationStatus) return;
  const code = cat.utils.automationUtils.getAutomationStatus(document);
  let status;
  switch (code) {
    case codes.UNAVAILABLE:
      if (!item || (cat.utils.documentUtils.getSource(document) ?? 'none') !== 'none') status = colors.UNKNOWN;
      break;
    case codes.AVAILABLE: status = colors.AVAILABLE; break;
    case codes.OUTDATED: status = colors.OUTDATED; break;
    case codes.UP_TO_DATE: status = colors.UP_TO_DATE; break;
    case codes.CONFIGURABLE:
    case codes.GENERIC: status = colors.CONFIGURABLE; break;
  }
  if (status) button.dataset.medkitStatus = status;
  else delete button.dataset.medkitStatus;
}
