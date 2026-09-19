import { renderHandlebarsTemplate } from 'src/foundry/core-compat';
import { error } from 'src/utils/logging';

export class HandlebarsTemplateRenderer {
  path: string;

  constructor(props: Partial<HandlebarsTemplateRenderer>) {
    this.path = props?.path ?? '';
  }

  async render(data: any) {
    try {
      return await renderHandlebarsTemplate(this.path, data);
    } catch (e) {
      error('Failed to render handlebars template', false, e);
      return '';
    }
  }
}
