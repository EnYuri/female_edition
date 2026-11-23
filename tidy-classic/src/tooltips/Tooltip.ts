export class Tooltip {
  static show(target: HTMLElement, markup: string, theme: string) {
    game.tooltip.activate(target, {
      html: markup,
      cssClass: `fe-tidy-sheet tidy5e-sheet application quadrone tooltip themed theme-${theme}`,
    });
  }
  static hide() {
    game.tooltip.deactivate();
  }
}
