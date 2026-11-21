const REQUEST = 'female_edition.classicLootRequest';
const GRANT = 'female_edition.classicLootGrant';
const GRANT_TIMEOUT = 120000;
const REVISION = 'classicLootRevision';

function authority(actor) {
  return game.users.activeGM ?? [...game.users]
    .filter(user => user.active && actor.testUserPermission(user, 'OWNER'))
    .sort((a, b) => a.id.localeCompare(b.id, 'en'))[0];
}

function revision(actor) {
  return actor.getFlag('female_edition', REVISION) ?? null;
}

async function waitForRevision(actor, expected) {
  const deadline = Date.now() + 10000;
  while (revision(actor) !== expected) {
    if (Date.now() >= deadline) throw new Error('액터의 전리품 변경을 동기화하지 못했습니다.');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

// The coordinator orders turns. Importers and document writes always run on the
// initiating client with its own permissions. Only IDs travel between users.
export function createLootTurns(currentUser = () => game.user, select = authority, resolve = uuid => fromUuid(uuid)) {
  const pending = new Map();
  const queues = new Map();

  async function enqueue(actor, run) {
    const previous = queues.get(actor.uuid) ?? Promise.resolve();
    const turn = previous.catch(() => {}).then(async () => {
      if (select(actor)?.id !== currentUser().id) throw new Error('전리품 지급 담당자가 변경되었습니다.');
      const committed = await run(revision(actor));
      if (committed) await waitForRevision(actor, committed);
    });
    queues.set(actor.uuid, turn);
    try { await turn; }
    finally { if (queues.get(actor.uuid) === turn) queues.delete(actor.uuid); }
  }

  return {
    register(queries) {
      queries[REQUEST] = async ({ uuid, id }, { user }) => {
        const actor = await resolve(uuid);
        if (actor?.documentName !== 'Actor' || !actor.testUserPermission(user, 'OWNER'))
          throw new Error('액터 소유 권한이 필요합니다.');
        await enqueue(actor, expected => user.query(GRANT, { id, expected, expires: game.time.serverTime + GRANT_TIMEOUT }, { timeout: GRANT_TIMEOUT }));
        return true;
      };
      queries[GRANT] = async ({ id, expected, expires }, { user }) => {
        const request = pending.get(id);
        if (!request || user.id !== request.coordinator || select(request.actor)?.id !== user.id)
          throw new Error('유효하지 않은 전리품 지급 요청입니다.');
        pending.delete(id);
        await waitForRevision(request.actor, expected);
        return request.run(expires);
      };
    },
    async run(actor, commit) {
      const coordinator = select(actor);
      if (!coordinator) throw new Error('접속 중인 액터 소유자가 없습니다.');
      const id = foundry.utils.randomID();
      const run = (expires = Infinity) => commit(id, () => {
        if (Number.isFinite(expires) && game.time.serverTime >= expires - 5000)
          throw new Error('전리품 지급 요청 시간이 만료되었습니다.');
        if (!actor.isOwner || select(actor)?.id !== coordinator.id)
          throw new Error('전리품 지급 중 액터 권한 또는 담당자가 변경되었습니다.');
      });
      if (coordinator.id === currentUser().id) return enqueue(actor, () => run());
      pending.set(id, { actor, coordinator: coordinator.id, run });
      try { await coordinator.query(REQUEST, { uuid: actor.uuid, id }, { timeout: GRANT_TIMEOUT * 2 }); }
      finally { pending.delete(id); }
    },
  };
}

export const lootTurns = createLootTurns();
export const lootRevisionPath = 'flags.female_edition.' + REVISION;
