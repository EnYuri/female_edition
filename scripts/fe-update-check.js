// female_edition: package update notifier.
// Self-contained entry-point script. Uses Foundry's package check API first and
// falls back to direct manifest fetch if the API is unavailable in-world.
// Cache lives in localStorage so it never enters GM-priority/per-world setting sync.

const FE_UPD_MODULE_ID = "female_edition";
const FE_UPD_FALLBACK_MANIFEST = "https://github.com/EnYuri/female_edition/releases/latest/download/module.json";
const FE_UPD_CACHE_KEY = "female_edition.updateCheck.v1";
const FE_UPD_SESSION_PREFIX = "female_edition.updateNotified.";
const FE_UPD_CACHE_TTL_MS = 27 * 60 * 60 * 1000;

if (!globalThis.__femaleEditionUpdateCheckInstalled) {
  globalThis.__femaleEditionUpdateCheckInstalled = true;

  Hooks.once("ready", () => {
    if (!game?.user?.isGM) return;
    setTimeout(() => {
      void feUpdCheckForUpdate();
    }, 4000);
  });
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

  const sessionKey = `${FE_UPD_SESSION_PREFIX}${latest}`;
  try {
    if (sessionStorage.getItem(sessionKey)) return;
    sessionStorage.setItem(sessionKey, "1");
  } catch {
    // If sessionStorage is unavailable, still notify once through the ready hook.
  }

  ui.notifications?.warn(
    `Female-cupwhi 업데이트 가능: 현재 ${local}, 최신 ${latest}. Foundry의 모듈 관리 화면에서 업데이트를 확인하세요.`,
    { permanent: true, console: false },
  );
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

async function feUpdCheckViaManifestFetch() {
  const baseUrl = feUpdManifestUrl();
  const join = baseUrl.includes("?") ? "&" : "?";
  const url = `${baseUrl}${join}_feUpdateCheck=${Date.now()}`;
  const response = await fetch(url, {
    cache: "no-store",
    credentials: "omit",
    redirect: "follow",
  });
  if (!response?.ok) throw new Error(`HTTP ${response?.status ?? "unknown"}`);
  const manifest = await response.json();
  const latestVersion = String(manifest?.version || "").trim();
  return {
    latestVersion,
    isUpgrade: feUpdIsNewer(latestVersion, feUpdVersionOf()),
    isTrackChange: false,
  };
}

async function feUpdCheckRemote() {
  try {
    const checked = await feUpdCheckViaFoundryApi();
    if (checked?.latestVersion) return { ...checked, source: "foundry" };
  } catch (err) {
    console.warn("female_edition | Foundry package update check failed; falling back to manifest fetch", err);
  }

  const checked = await feUpdCheckViaManifestFetch();
  return { ...checked, source: "manifest" };
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

  try {
    const checked = await feUpdCheckRemote();
    const latestVersion = String(checked?.latestVersion || "").trim();
    if (!latestVersion) return;

    feUpdWriteCache({
      checkedAt: now,
      latestVersion,
      manifest: feUpdManifestUrl(),
      source: checked?.source ?? "unknown",
    });

    if (checked?.isUpgrade || feUpdIsNewer(latestVersion, localVersion)) feUpdNotify(latestVersion, localVersion);
  } catch (err) {
    console.warn("female_edition | update check failed", err);
  }
}
