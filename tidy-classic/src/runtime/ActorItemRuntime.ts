import { openClassicQuickInsert } from 'src/integration/quick-insert.js';
import type { ActorItemSectionCommand } from 'src/api/api.types';
import type {
  RegisteredSectionCommand,
  RegisteredSectionCommandEnabledParams,
  RegisteredSectionCommandExecuteParams,
} from './types';
import { error } from 'src/utils/logging';
import type { SectionCommand } from 'src/types/types';

export class ActorItemRuntime {
  private static _actorItemSectionCommands: RegisteredSectionCommand[] = [];

  static registerActorItemSectionCommands(commands: ActorItemSectionCommand[]) {
    const sectionCommands: RegisteredSectionCommand[] = commands.map(
      (command) => ({
        ...command,
        enabled: command.enabled
          ? (params: RegisteredSectionCommandEnabledParams) =>
              command.enabled?.({ ...params, actor: params.document }) ?? true
          : undefined,
        execute: (params: RegisteredSectionCommandExecuteParams) => {
          const args = { ...params, actor: params.document };
          if (command.tooltip === 'Quick Insert' && command.iconClass === 'fas fa-search' &&
              (globalThis as any).QuickInsert?.systemIntegration?.Dnd5eSheetContext) {
            return openClassicQuickInsert(args);
          }
          return command.execute?.(args);
        },
      })
    );

    ActorItemRuntime._actorItemSectionCommands.push(...sectionCommands);
  }

  static getActorItemSectionCommands({
    section,
    document,
    unlocked,
  }: RegisteredSectionCommandEnabledParams): SectionCommand[] {
    return [...ActorItemRuntime._actorItemSectionCommands].filter((c) => {
      try {
        return (
          section && (c.enabled?.({ section, document, unlocked }) ?? true)
        );
      } catch (e) {
        error(
          'Failed to check if actor item section command is enabled',
          false,
          { error: e, document, section }
        );
        return false;
      }
    });
  }
}
