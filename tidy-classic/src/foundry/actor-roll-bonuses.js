// The 6.x model can omit an unconfigured bonus. DAE installs getters on the
// old 5.x paths even then, so select the schema before reading either value.
function getRollBonus(actor, actionType, kind) {
  const system = actor?.system;
  if (!system) return '';
  const usesRolls = system.schema?.fields?.rolls || 'rolls' in system;
  const bonus = usesRolls
    ? system.rolls?.[kind]?.[actionType]?.bonus
    : system.bonuses?.[actionType]?.[kind];
  return typeof bonus === 'string' ? bonus : '';
}

export function getActorAttackBonus(actor, actionType) {
  return getRollBonus(actor, actionType, 'attack');
}

export function getActorDamageBonus(actor, actionType) {
  return getRollBonus(actor, actionType, 'damage');
}
