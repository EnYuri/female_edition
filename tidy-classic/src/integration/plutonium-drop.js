import { lootTurns, lootRevisionPath } from './plutonium-loot-turns.js';

/** Plutonium patches the official sheets when both Tidy providers are active. */
export function isPlutoniumSheetDrop(data, document = null) {
  if (data?.type === 'JournalEntryPage' && document?.flags?.plutonium?.type !== 'loot') return false;
  if (!game.modules.get('tidy5e-sheet')?.active || !game.modules.get('plutonium')?.active) return false;
  return data?.type === 'JournalEntryPage' || data?.type === 've-Loot' || (data?.type === 'Item' &&
    ['srd5e.Import', 'srd5e.Hover'].includes(data.subType) &&
    Boolean(data.page && data.source && data.hash));
}

function checkImport(summary) {
  // Plutonium can resolve with a failure or cancellation instead of throwing.
  if (summary?.isFailed?.() || summary?.status?.description === 'taskExitCancelled') {
    throw new Error(summary.getNotificationMeta?.().message ?? '전리품 임포트가 중단되었습니다.');
  }
}

async function stageLoot(api, actor, loot, id, checkAuthority) {
  // A detached clone has no ID. Plutonium routes embedded creations and stack
  // updates on it through its temporary-document path, including pack contents.
  const staged = actor.clone({}, { parent: null, pack: null });
  const before = staged.toObject();
  const importers = new Map();
  for (const { page, entity, options } of loot.entityInfos ?? []) {
    let importer = importers.get(page);
    if (!importer) {
      importer = await api.importer.pGetImporter({ page });
      if (importer?.constructor.FOLDER_TYPE !== 'Item') throw new Error('지원하지 않는 전리품 종류입니다.');
      importers.set(page, importer);
    }
    const opts = new api.importer.ImportOpts({ actor: staged, isSpellScroll: options?.isSpellScroll });
    checkImport(await importer.pImportEntry(entity, opts, { quantity: options?.quantity }));
  }

  const currency = Object.fromEntries(Object.entries(loot.currency ?? {}).filter(([key, value]) =>
    Object.hasOwn(CONFIG.DND5E.currencies, key) && Number.isFinite(value) && value > 0));
  const update = {};
  if (Object.keys(currency).length && actor.type === 'npc' &&
      api.config.getValue('currency', 'isNpcUseCurrencySheetItems')) {
    const importer = await api.importer.pGetImporter({ page: 'items.html' });
    checkImport(await importer.pImportCurrency(currency, new api.importer.ImportOpts({ actor: staged })));
  } else {
    for (const [key, amount] of Object.entries(currency)) {
      update['system.currency.' + key] = (actor.system.currency?.[key] ?? 0) + amount;
    }
  }

  // Foundry merges embedded records by _id on a parent update. Write only
  // changed records; keep transferred effects on their owning item.
  const equals = foundry.utils.equals ?? foundry.utils.objectsEqual;
  const legacySource = game.release?.generation < 14 ? actor.toObject() : null;
  for (const field of ['items', 'effects']) {
    const originals = new Map(before[field].map(data => [data._id, data]));
    const changes = [];
    const legacyRecords = legacySource && new Map(legacySource[field].map(data => [data._id, data]));
    for (const doc of staged[field].values()) {
      if (doc.parent !== staged) continue;
      const original = originals.get(doc.id);
      const data = doc.toObject();
      const delta = original ? foundry.utils.diffObject(original, data, { bidirectional: true }) : data;
      if (!Object.keys(delta).length) continue;
      const live = actor[field].get(doc.id);
      if (original ? !live || !equals(original, live.toObject()) : live) {
        throw new Error('전리품을 준비하는 동안 액터의 아이템 또는 효과가 변경되었습니다.');
      }
      changes.push({ ...delta, _id: doc.id });
      legacyRecords?.set(doc.id, data);
    }
    if (changes.length) update[field] = legacyRecords ? [...legacyRecords.values()] : changes;
  }
  if (!Object.keys(update).length) return null;
  checkAuthority();
  update[lootRevisionPath] = id;
  if (!await actor.update(update)) {
    throw new Error('액터의 전리품 저장이 취소되었습니다.');
  }
  return id;
}

export async function handlePlutoniumSheetDrop(sheet, event, data, document = null) {
  const journalLoot = data.type === 'JournalEntryPage';
  if (!sheet.isEditable || !sheet.actor.isOwner) return true;
  const api = game.modules.get('plutonium').api;
  try {
    if (journalLoot || data.type === 've-Loot') {
      const loot = journalLoot ? document.flags.plutonium.loot : data.data;
      await lootTurns.run(sheet.actor, (id, checkAuthority) => stageLoot(api, sheet.actor, loot, id, checkAuthority));
    } else if (data.isDragDropForcePlutoniumImport) {
      const redirect = (api.config.getValue('text', 'isForceRedirectImports') ||
        (data.isAllowRedirect && api.config.getValue('text', 'isAllowRedirectImports'))) &&
        globalThis.VetoolsConfig.get('styleSwitcher', 'style') === 'one'
        ? await globalThis.Renderer.redirect.pGetRedirectByHash(data.page, data.hash) : null;
      const { page, source, hash } = redirect || data;
      const entity = await globalThis.DataLoader.pCacheAndGet(page, source, hash, { isCopy: true });
      const importer = await api.importer.pGetImporter({ prop: entity?.__prop || page });
      if (!entity || importer?.constructor.FOLDER_TYPE !== 'Item') throw new Error('아이템을 찾을 수 없습니다.');
      const preview = await importer.pImportEntry(entity, new api.importer.ImportOpts({ isTemp: true }));
      checkImport(preview);
      const temporary = preview?.getPrimaryDocument?.();
      if (temporary?.documentName !== 'Item') throw new Error('아이템을 찾을 수 없습니다.');
      const item = temporary.clone({ 'flags.plutonium.isStandardDragDrop': true }, { keepId: true });
      await sheet._onDropItemCreate(item, event, 'copy', async () => {
        const result = await importer.pImportEntry(entity, new api.importer.ImportOpts({ actor: sheet.actor }));
        checkImport(result);
        return result?.getPrimaryDocument?.();
      });
    } else {
      // Plutonium's Item.fromDropData wrapper creates a temporary document.
      // Classic owns the actual copy, including its cancellable dnd5e drop hook.
      const item = await Item.implementation.fromDropData(data);
      if (item?.documentName !== 'Item') throw new Error('아이템을 찾을 수 없습니다.');
      const copy = item.getFlag('plutonium', 'propDroppable')
        ? item.clone({ 'flags.plutonium.isStandardDragDrop': true }, { keepId: true }) : item;
      await sheet._onDropItemCreate(copy, event, 'copy');
    }
  } catch (error) {
    console.error('female_edition | Plutonium drop', error);
    ui.notifications.error('Plutonium 드롭을 처리하지 못했습니다. 콘솔에서 상세 오류를 확인하세요.');
  }
  return true;
}
