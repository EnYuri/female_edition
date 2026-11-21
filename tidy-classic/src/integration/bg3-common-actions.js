/** BG3 normally assigns this Tidy section while loading a saved combat hotbar. */
export function bg3CommonActionSection(item) {
  if (!item.actor || game.modules.get('tidy5e-sheet')?.active ||
      !game.modules.get('bg3-inspired-hotbar')?.active || !game.modules.get('chris-premades')?.active ||
      item.getFlag('chris-premades', 'info')?.source !== 'chris-premades') return;
  const slots = item.actor.getFlag('bg3-inspired-hotbar', 'containersConfig')?.combat?.[0]?.items;
  if (slots && Object.values(slots).some(slot => slot?.uuid === item.uuid)) {
    return 'CHRISPREMADES.Generic.Actions';
  }
}
