function feMidiRollType(roll) {
  return String(roll?.options?.["midi-qol"]?.rollType ?? "");
}

function feMidiDamageType(roll) {
  const type = roll?.options?.type ?? roll?.options?.types?.[0];
  return typeof type === "string" ? type.trim() : "";
}

function feMidiDamageConfig(type) {
  if (!type) return null;
  return CONFIG?.DND5E?.damageTypes?.[type]
    ?? CONFIG?.DND5E?.healingTypes?.[type]
    ?? null;
}

export function feHasRestorableMidiDamageTypes(message) {
  try {
    const rolls = Array.isArray(message?.rolls) ? message.rolls : [];
    return rolls.some((roll) => {
      const type = feMidiDamageType(roll);
      return !!feMidiDamageConfig(type)?.icon;
    });
  } catch {
    return false;
  }
}

function feMidiExpectedRollType(element) {
  if (element?.classList?.contains?.("midi-bonus-damage-roll")) return "bonusDamage";
  if (element?.classList?.contains?.("midi-other-damage-roll")) return "otherDamage";
  return "defaultDamage";
}

/**
 * Restore damage-type icons on midi-qol cards saved before midi-qol 13.0.55.
 *
 * Those messages retain authoritative DamageRoll options but their stored HTML
 * predates `.midi-damage-type-icon`. New cards already carry the icon and are
 * left untouched.
 */
export function feRestoreMidiDamageTypeIcons(message, root) {
  try {
    if (!root?.querySelectorAll || !CONFIG?.DND5E) return 0;

    const rolls = Array.isArray(message?.rolls) ? message.rolls : [];
    const candidates = rolls
      .map((roll, index) => ({
        roll,
        index,
        rollType: feMidiRollType(roll),
        type: feMidiDamageType(roll),
      }))
      .filter(({ type }) => !!feMidiDamageConfig(type)?.icon);
    if (!candidates.length) return 0;

    const used = new Set();
    let restored = 0;
    const elements = root.querySelectorAll(
      ".midi-damage-roll, .midi-bonus-damage-roll, .midi-other-damage-roll",
    );

    for (const element of elements) {
      if (element.querySelector?.(".midi-damage-type-icon")) continue;
      const total = element.querySelector?.(".dice-total");
      if (!total?.appendChild) continue;

      const expected = feMidiExpectedRollType(element);
      let candidate = candidates.find(({ index, rollType }) => !used.has(index) && rollType === expected);
      // Very old messages may predate midi's rollType option too. DamageRoll
      // document order matches these rendered roll containers, so use the next
      // typed roll as the compatibility fallback.
      candidate ??= candidates.find(({ index }) => !used.has(index));
      if (!candidate) continue;

      const config = feMidiDamageConfig(candidate.type);
      if (!config?.icon) continue;
      const doc = total.ownerDocument ?? root.ownerDocument ?? document;
      const icon = doc.createElement("dnd5e-icon");
      icon.className = "midi-damage-type-icon";
      icon.setAttribute("src", config.icon);
      const label = game?.i18n?.localize?.(config.label) ?? config.label ?? candidate.type;
      icon.setAttribute("aria-label", String(label));
      icon.setAttribute("data-tooltip", String(label));
      icon.dataset.feRestoredDamageType = candidate.type;
      total.appendChild(icon);
      used.add(candidate.index);
      restored += 1;
    }
    return restored;
  } catch {
    return 0;
  }
}

function feMidiItemDetailsAllowed(item) {
  try {
    const settings = game?.modules?.get?.("midi-qol")?.api?.configSettings?.();
    if (!settings) return false;
    const mode = settings.showItemDetails;
    if ((mode !== "all") && !((mode === "pc") && item?.actor?.hasPlayerOwner)) return false;
    const types = Array.isArray(settings.itemTypeList) ? settings.itemTypeList : [];
    return types.includes(item?.type);
  } catch {
    return false;
  }
}

/**
 * dnd5e 6 activity cards can carry an empty activity description even when
 * midi's "Show Item Details" is enabled. Restore the parent item's description
 * only into the empty legacy wrapper; populated/suppressed cards are untouched.
 */
export async function feRestoreMidiItemDescription(message, root) {
  try {
    if (!root?.querySelector) return 0;
    const wrapper = root.querySelector(
      ".midi-chat-card .card-header.description.collapsible"
      + " > .details.collapsible-content.card-content > .wrapper",
    );
    if (!wrapper || wrapper.querySelector("*") || wrapper.textContent?.trim()) return 0;

    const flags = message?.flags?.["midi-qol"] ?? {};
    const card = wrapper.closest?.(".midi-chat-card");
    const itemUuid = flags?.dnd5e?.item?.uuid
      ?? flags?.activityUuid?.split?.(".Activity.")?.[0]
      ?? card?.dataset?.itemUuid
      ?? "";
    const item = globalThis.fromUuidSync?.(itemUuid);
    if (!item || !feMidiItemDetailsAllowed(item)) return 0;
    const source = item.system?.description?.value;
    if (typeof source !== "string" || !source.trim()) return 0;

    const enriched = await TextEditor.implementation.enrichHTML(source, {
      rollData: item.getRollData?.() ?? {},
      secrets: item.isOwner ?? game?.user?.isGM,
    });
    // A later renderer may have populated or replaced the wrapper while enrichHTML
    // awaited document links. Never overwrite real message content.
    if (!wrapper.isConnected && root.isConnected) return 0;
    if (wrapper.querySelector("*") || wrapper.textContent?.trim()) return 0;
    wrapper.innerHTML = enriched;
    wrapper.dataset.feRestoredItemDescription = "1";
    return 1;
  } catch {
    return 0;
  }
}
