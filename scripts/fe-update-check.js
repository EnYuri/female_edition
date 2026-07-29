// female_edition: package update notifier.
// Self-contained entry-point script. Uses Foundry's server-side package APIs so
// remote GitHub manifests are never fetched directly by the browser (CORS).
// Cache lives in localStorage so it never enters GM-priority/per-world setting sync.

const FE_UPD_MODULE_ID = "female_edition";
const FE_UPD_FALLBACK_MANIFEST = "https://github.com/EnYuri/female_edition/releases/latest/download/module.json";
// This is intentionally a browser fetch. GitHub's REST API sends CORS headers,
// unlike release-asset redirect URLs; it is usable from an active game world.
const FE_UPD_GITHUB_LATEST_RELEASE = "https://api.github.com/repos/EnYuri/female_edition/releases/latest";
const FE_UPD_CACHE_KEY = "female_edition.updateCheck.v1";
const FE_UPD_CHAT_DISABLED_KEY = "female_edition.updateCheck.chatDisabled";
const FE_UPD_CACHE_TTL_MS = 27 * 60 * 60 * 1000;
const FE_UPD_FAILURE_TTL_MS = 60 * 60 * 1000;
const FE_UPD_NOTIFIED_THIS_LOAD = new Set();

if (!globalThis.__femaleEditionUpdateCheckInstalled) {
  globalThis.__femaleEditionUpdateCheckInstalled = true;

  Hooks.once("ready", () => {
    if (!game?.user?.isGM) return;
    setTimeout(() => {
      void feUpdCheckForUpdate();
    }, 4000);
  });

  // Wire the "흐에알겠는" dismiss button on our update-notice chat card.
  Hooks.on("renderChatMessageHTML", (message, html) => {
    try {
      if (!message?.flags?.female_edition?.updateNotice) return;
      const el = html?.nodeType ? html : (html?.[0] ?? html);
      // Reuse the chat-merge header-hide styling to drop the speaker header.
      el?.classList?.add?.("fe-update-notice-card");
      const btn = el?.querySelector?.("[data-fe-upd-dismiss]");
      if (!btn) return;
      // The dismiss control is GM-only (it turns off the notice + deletes the card,
      // which non-GMs can't do). Players still see the informational card.
      if (!game?.user?.isGM) { btn.remove(); return; }
      if (btn.dataset.feUpdBound === "1") return;
      btn.dataset.feUpdBound = "1";
      btn.addEventListener("click", async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        feUpdSetChatDisabled(true);
        ui.notifications?.info("흐에... 이제 업데이트 채팅 알림은 안 보내는 거에요챱 (토스트 알림은 그대로인)");
        try { await message.delete(); } catch { /* no-op */ }
      });
    } catch (err) {
      console.warn("female_edition | update-notice button wiring failed", err);
    }
  });
}

function feUpdChatDisabled() {
  try { return localStorage.getItem(FE_UPD_CHAT_DISABLED_KEY) === "1"; }
  catch { return false; }
}

function feUpdSetChatDisabled(disabled) {
  try {
    if (disabled) localStorage.setItem(FE_UPD_CHAT_DISABLED_KEY, "1");
    else localStorage.removeItem(FE_UPD_CHAT_DISABLED_KEY);
  } catch { /* no-op */ }
}

function feUpdModule() {
  try { return game.modules?.get?.(FE_UPD_MODULE_ID) ?? null; }
  catch { return null; }
}

function feUpdManifestUrl(mod = feUpdModule()) {
  const url = mod?.manifest ?? mod?.manifestURL ?? mod?.manifestUrl ?? FE_UPD_FALLBACK_MANIFEST;
  const clean = String(url || "").trim();
  return clean || FE_UPD_FALLBACK_MANIFEST;
}

function feUpdVersionOf(mod = feUpdModule()) {
  const version = mod?.version ?? mod?.data?.version ?? "";
  return String(version || "").trim();
}

function feUpdReadCache() {
  try {
    const raw = localStorage.getItem(FE_UPD_CACHE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function feUpdWriteCache(data) {
  try {
    localStorage.setItem(FE_UPD_CACHE_KEY, JSON.stringify(data ?? {}));
  } catch {
    // no-op
  }
}

function feUpdIsNewer(remoteVersion, localVersion) {
  const remote = String(remoteVersion || "").replace(/^v/i, "").trim();
  const local = String(localVersion || "").replace(/^v/i, "").trim();
  if (!remote || !local) return false;

  try {
    if (foundry?.utils?.isNewerVersion) return !!foundry.utils.isNewerVersion(remote, local);
  } catch {
    // fall through
  }

  const split = (v) => v.split(/[.+-]/).map((part) => {
    const n = Number.parseInt(part, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const a = split(remote);
  const b = split(local);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }
  return false;
}

function feUpdNotify(latestVersion, localVersion) {
  const latest = String(latestVersion || "").trim();
  const local = String(localVersion || "").trim();
  if (!latest || !local) return;

  const loadKey = `${local}->${latest}`;
  if (FE_UPD_NOTIFIED_THIS_LOAD.has(loadKey)) return;
  FE_UPD_NOTIFIED_THIS_LOAD.add(loadKey);

  ui.notifications?.warn(
    `흐에!!! 암컷모듈(Female_edition, aka. Female-cupwhi)을 업데이트 할 수 있는!!: 현재 ${local}이지만, 최신은 ${latest}인. 확인하시는거에요챱`,
    { permanent: true, console: false },
  );

  void feUpdPostChatNotice(latest, local, loadKey);
}

function feUpdBuildNoticeContent(latest, local) {
  const esc = (v) => foundry.utils.escapeHTML?.(String(v)) ?? String(v);
  return `
<div class="fe-update-notice" style="border:2px solid var(--color-warm-2,#c9a13b);border-radius:10px;padding:10px 12px;background:rgba(0,0,0,0.28);">
  <div style="display:flex;align-items:center;gap:8px;font-weight:bold;font-size:1.05em;margin-bottom:6px;">
    <i class="fas fa-arrow-up-right-dots"></i>
    <span>암컷모듈 업데이트가 있는 거에요!</span>
  </div>
  <div style="line-height:1.5;">
    흐에흐에!!! <b>Female_edition</b> (aka. Female-cupwhi) 을 업데이트 할 수 있는거에요!!<br>
    그룬데 현재버전은 <b>${esc(local)}</b> 이구, 최신은 <b>${esc(latest)}</b> 인 거에요...<br>
    글애서 <b>FVTT 셋업 → 부가 모듈</b> 탭에서 업데이트를 확인하시는거에요챱
  </div>
  <div style="margin-top:10px;text-align:right;">
    <button type="button" data-fe-upd-dismiss style="cursor:pointer;">
      <i class="fas fa-check"></i> 흐에알겠는
    </button>
  </div>
</div>`.trim();
}

async function feUpdPostChatNotice(latest, local, loadKey) {
  try {
    if (feUpdChatDisabled()) return;
    if (!feUpdIsPrimaryActiveGM()) return;
    if (typeof ChatMessage?.create !== "function") return;

    // Dedupe across reloads: post the chat card once per version transition.
    const cached = feUpdReadCache();
    if (String(cached.chatNotifiedFor || "") === loadKey) return;
    if (feUpdHasPostedChatNotice(latest, local)) return;

    await ChatMessage.create({
      content: feUpdBuildNoticeContent(latest, local),
      speaker: { alias: "Female Edition" },
      flags: { female_edition: { updateNotice: { latest, local } } },
    });

    // Record only after a successful post, so a failed create can retry next load.
    feUpdWriteCache({ ...feUpdReadCache(), chatNotifiedFor: loadKey });
  } catch (err) {
    console.warn("female_edition | update-notice chat post failed", err);
  }
}

function feUpdIsPrimaryActiveGM() {
  try {
    const gms = Array.from(game.users ?? [])
      .filter((user) => user?.active && user?.isGM)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return !gms.length || gms[0]?.id === game.user?.id;
  } catch {
    return true;
  }
}

function feUpdHasPostedChatNotice(latest, local) {
  try {
    return Array.from(game.messages ?? []).some((message) => {
      const notice = message?.flags?.[FE_UPD_MODULE_ID]?.updateNotice;
      return notice && String(notice?.latest ?? "") === latest && String(notice?.local ?? "") === local;
    });
  } catch {
    return false;
  }
}

function feUpdExtractPackageCheckVersion(response) {
  const remote = response?.remote ?? null;
  const trackChange = response?.trackChange ?? null;
  const latestVersion = String(remote?.version ?? trackChange?.version ?? "").trim();
  return {
    latestVersion,
    isUpgrade: !!response?.isUpgrade || feUpdIsNewer(latestVersion, feUpdVersionOf()),
    isTrackChange: !!trackChange,
  };
}

async function feUpdCheckViaFoundryApi() {
  if (typeof game?.checkPackage !== "function") return null;
  const response = await game.checkPackage({
    type: "module",
    id: FE_UPD_MODULE_ID,
    timeout: 15000,
  });
  return feUpdExtractPackageCheckVersion(response);
}

async function feUpdCheckViaGitHubRelease() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(FE_UPD_GITHUB_LATEST_RELEASE, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub release query failed (${response.status})`);
    const release = await response.json();
    const latestVersion = String(release?.tag_name ?? "").trim();
    if (!latestVersion) throw new Error("GitHub latest release has no tag_name");
    return {
      latestVersion,
      isUpgrade: feUpdIsNewer(latestVersion, feUpdVersionOf()),
      isTrackChange: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function feUpdCheckViaRemoteManifest() {
  const manifestUrl = feUpdManifestUrl();
  let remote = null;

  const ModulePackage = globalThis.foundry?.packages?.Module;
  if (typeof ModulePackage?.fromRemoteManifest === "function") {
    remote = await ModulePackage.fromRemoteManifest(manifestUrl, { strict: false });
  } else if (typeof game?.post === "function") {
    const data = await game.post(
      { action: "getPackageFromRemoteManifest", type: "module", manifest: manifestUrl },
      { notify: false, timeoutMs: 15000 },
    );
    if (data) remote = { version: data.version };
  }

  const latestVersion = String(remote?.version || "").trim();
  return {
    latestVersion,
    isUpgrade: feUpdIsNewer(latestVersion, feUpdVersionOf()),
    isTrackChange: false,
  };
}

async function feUpdCheckRemote() {
  try {
    const checked = await feUpdCheckViaGitHubRelease();
    if (checked?.latestVersion) return { ...checked, source: "github-release" };
  } catch (err) {
    console.warn("female_edition | GitHub release update check failed; trying Foundry compatibility paths", err);
  }

  try {
    const checked = await feUpdCheckViaFoundryApi();
    if (checked?.latestVersion) return { ...checked, source: "foundry" };
  } catch (err) {
    console.warn("female_edition | Foundry package update check failed; falling back to remote manifest API", err);
  }

  const checked = await feUpdCheckViaRemoteManifest();
  return { ...checked, source: "remote-manifest" };
}

async function feUpdCheckForUpdate() {
  const localVersion = feUpdVersionOf();
  if (!localVersion) return;

  const now = Date.now();
  const cached = feUpdReadCache();
  const cachedLatest = String(cached.latestVersion || "").trim();
  const cachedAt = Number(cached.checkedAt) || 0;

  if (cachedLatest && (now - cachedAt) < FE_UPD_CACHE_TTL_MS) {
    if (feUpdIsNewer(cachedLatest, localVersion)) feUpdNotify(cachedLatest, localVersion);
    return;
  }
  if ((now - (Number(cached.failedAt) || 0)) < FE_UPD_FAILURE_TTL_MS) return;

  try {
    const checked = await feUpdCheckRemote();
    const latestVersion = String(checked?.latestVersion || "").trim();
    if (!latestVersion) throw new Error("No latest module version returned by any update source");

    // Spread the existing cache — this write owns only the check-result fields, and a
    // bare object literal here silently dropped `chatNotifiedFor` (written at :183)
    // every time the 27h TTL expired. That is the PRIMARY chat-card dedupe; losing it
    // left the whole thing resting on feUpdHasPostedChatNotice's game.messages scan,
    // which only holds while the card is still in the log. Flush the chat and the
    // notice reappears once per TTL. The other two write sites both spread already.
    feUpdWriteCache({
      ...feUpdReadCache(),
      checkedAt: now,
      latestVersion,
      manifest: feUpdManifestUrl(),
      source: checked?.source ?? "unknown",
      failedAt: 0,
    });

    if (checked?.isUpgrade || feUpdIsNewer(latestVersion, localVersion)) feUpdNotify(latestVersion, localVersion);
  } catch (err) {
    feUpdWriteCache({ ...feUpdReadCache(), failedAt: now });
    console.warn("female_edition | update check failed", err);
  }
}
