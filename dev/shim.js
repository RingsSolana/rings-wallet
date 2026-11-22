// Dev only, never shipped: a chrome.* stand-in so the background and pages run in a normal tab (dev/serve.mjs).
(() => {
  const load = (s, k) => {
    try {
      return JSON.parse(s.getItem(k) || "{}");
    } catch {
      return {};
    }
  };
  const areas = { local: load(localStorage, "dev-local"), session: load(sessionStorage, "dev-session") };
  const save = () => {
    localStorage.setItem("dev-local", JSON.stringify(areas.local));
    sessionStorage.setItem("dev-session", JSON.stringify(areas.session));
  };
  const area = (name) => ({
    get: async (k) => (typeof k === "string" ? (k in areas[name] ? { [k]: areas[name][k] } : {}) : { ...areas[name] }),
    set: async (o) => {
      Object.assign(areas[name], JSON.parse(JSON.stringify(o)));
      save();
    },
    remove: async (k) => {
      delete areas[name][k];
      save();
    },
    setAccessLevel: async () => undefined,
  });
  const listeners = [];
  const alarmListeners = [];
  const timers = {};
  const id = "dev-extension";
  const chromeShim = {
    runtime: {
      id,
      getURL: (p) => `${location.origin}/${p.replace(/^\//, "")}`,
      getManifest: () => ({ version: "0.1.0-dev" }),
      sendMessage: (msg) =>
        new Promise((resolve) => {
          const sender = { id, url: location.href };
          for (const l of listeners) if (l(JSON.parse(JSON.stringify(msg)), sender, resolve) === true) return;
          resolve(undefined);
        }),
      onMessage: { addListener: (f) => listeners.push(f) },
      // Site connections need the real extension.
      onConnect: { addListener: () => undefined },
      onInstalled: { addListener: () => undefined },
      OnInstalledReason: { INSTALL: "install" },
    },
    storage: { local: area("local"), session: area("session") },
    alarms: {
      create: async (name, { when, periodInMinutes }) => {
        clearTimeout(timers[name]);
        clearInterval(timers[name]);
        const fire = () => alarmListeners.forEach((f) => f({ name }));
        timers[name] = periodInMinutes ? setInterval(fire, periodInMinutes * 60_000) : setTimeout(fire, Math.max(0, when - Date.now()));
      },
      clear: async (name) => {
        clearTimeout(timers[name]);
        clearInterval(timers[name]);
      },
      onAlarm: { addListener: (f) => alarmListeners.push(f) },
    },
    tabs: {
      create: async ({ url }) => {
        setTimeout(() => (location.href = url), 0);
        return { id: 1 };
      },
    },
    windows: {
      create: async ({ url }) => {
        window.open(url, "_blank", "width=376,height=640");
        return { id: 1 };
      },
      get: async () => null,
      remove: async () => undefined,
      onRemoved: { addListener: () => undefined },
    },
    action: {
      openPopup: async () => {
        location.href = "/popup.html";
      },
    },
  };
  Object.defineProperty(window, "chrome", { value: chromeShim, configurable: true, writable: true });
  // A tab has no host permissions: reach the devnet server through dev/serve.mjs's proxy.
  globalThis.__RINGS_DEVNET_ORIGIN = `${location.origin}/rings-devnet`;
})();
