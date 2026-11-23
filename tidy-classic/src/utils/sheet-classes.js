// Tidy 15 styles every .tidy5e-sheet as Quadrone. Keep the legacy DOM class
// for standalone integrations and Quadrone dialogs. The public sheet API reads
// app.options.classes, which retains the Tidy identity in either mode.
export function applyTidySheetClasses(element) {
  const classes = element.classList;
  classes.add('fe-tidy-sheet');
  const isolateClassic = classes.contains('classic') && game.modules.get('tidy5e-sheet')?.active;
  classes.toggle('tidy5e-sheet', !isolateClassic);
}
