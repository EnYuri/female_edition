// A repeat toggle only changes one button in each view of the track. Rebuilding
// the directory can clamp its scrollTop while search-expanded rows are collapsed.
const REPEAT_UPDATE = "fePlaylistRepeat";
const updatesDuringRender = new WeakMap();

function toggleRepeat(_event, button) {
  const row = button.closest(".sound[data-playlist-id][data-sound-id]");
  if (!row) return;
  const sound = game.playlists.get(row.dataset.playlistId)?.sounds.get(row.dataset.soundId);
  if (sound?.isOwner) return sound.update({ repeat: !sound.repeat }, { render: false, [REPEAT_UPDATE]: true });
}

function syncRepeatButton(app, sound) {
  const root = app.element?.[0] ?? app.element;
  const row = `.sound[data-playlist-id="${CSS.escape(sound.parent.id)}"][data-sound-id="${CSS.escape(sound.id)}"]`;
  for (const button of root?.querySelectorAll(`${row} [data-action="soundRepeat"]`) ?? []) {
    button.classList.toggle("inactive", !sound.repeat);
  }
}

Hooks.on("renderPlaylistDirectory", (app) => {
  const actions = app.options.actions;
  const directory = foundry.applications.sidebar?.tabs?.PlaylistDirectory ?? CONFIG.ui.playlists;
  const coreAction = directory?.DEFAULT_OPTIONS?.actions?.soundRepeat;
  if (typeof coreAction === "function" && actions?.soundRepeat === coreAction) actions.soundRepeat = toggleRepeat;

  // A render already in flight may have prepared its template with the old value.
  for (const sound of updatesDuringRender.get(app) ?? []) syncRepeatButton(app, sound);
  updatesDuringRender.delete(app);
});

Hooks.on("updatePlaylistSound", (sound, changed, options) => {
  if (!options[REPEAT_UPDATE] || options.render !== false) return;
  const playlist = sound.parent;

  // Keep open document sheets and other collection apps live on every client.
  sound.render(false, { renderContext: "updatePlaylistSound", renderData: changed });
  playlist.render(false, { renderContext: "updatesounds", renderData: [changed] });
  if (Object.keys(changed).some(key => key !== "_id" && key !== "repeat")) {
    // Another module added changes which may affect the row or its position.
    playlist.collection.render();
    return;
  }
  for (const app of playlist.collection.apps) {
    if (app !== ui.playlists) app.render(false);
  }

  for (const app of [ui.playlists, ui.playlists?.popout ?? ui.sidebar?.popouts?.playlists]) {
    if (!app) continue;
    syncRepeatButton(app, sound);
    if (app.state === app.constructor.RENDER_STATES.RENDERING) {
      if (!updatesDuringRender.has(app)) updatesDuringRender.set(app, new Set());
      updatesDuringRender.get(app).add(sound);
    }
  }
});
