/**
 * Delete a moved source only after this exact AdvancementManager has committed
 * its changes. Closing or cancelling the manager leaves the source untouched.
 */
export function watchAdvancementMove(manager, source, {
  hooks,
  resolveSource,
  onSourceChanged,
  onError,
}) {
  const uuid = source.uuid;
  const modifiedTime = source._stats?.modifiedTime;
  const hook = 'dnd5e.advancementManagerComplete';
  let active = true;

  function cleanup() {
    if (!active) return;
    active = false;
    hooks.off(hook, onComplete);
    if (typeof manager.removeEventListener === 'function') {
      manager.removeEventListener('close', onClose);
    } else {
      hooks.off('closeAdvancementManager', onLegacyClose);
    }
  }

  function onClose() {
    cleanup();
  }

  function onLegacyClose(closedManager) {
    if (closedManager === manager) cleanup();
  }

  function onComplete(completedManager) {
    if (completedManager !== manager || !active) return;
    cleanup();
    void (async () => {
      const current = await resolveSource(uuid);
      if (!current) return;
      if (modifiedTime != null && current._stats?.modifiedTime !== modifiedTime) {
        onSourceChanged?.(current);
        return;
      }
      await current.delete({ deleteContents: true });
    })().catch((error) => onError?.(error));
  }

  hooks.on(hook, onComplete);
  if (typeof manager.addEventListener === 'function') {
    manager.addEventListener('close', onClose, { once: true });
  } else {
    hooks.on('closeAdvancementManager', onLegacyClose);
  }
  return cleanup;
}
