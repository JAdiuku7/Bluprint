// Bluprint's App.jsx was written for the Claude.ai artifact sandbox, which
// provides a window.storage API (get/set/delete/list) backed by Anthropic's
// servers. That API doesn't exist in a normal browser, so when running this
// app locally via Vite we polyfill it with plain localStorage instead.
//
// This ONLY runs outside the Claude artifact sandbox — if window.storage is
// already defined (e.g. you paste this into an actual artifact), we leave
// it alone.
if (typeof window !== "undefined" && !window.storage) {
  const prefix = "bluprint-local:";

  window.storage = {
    async get(key) {
      const raw = localStorage.getItem(prefix + key);
      if (raw === null) return null;
      return { key, value: raw, shared: false };
    },
    async set(key, value) {
      localStorage.setItem(prefix + key, value);
      return { key, value, shared: false };
    },
    async delete(key) {
      const existed = localStorage.getItem(prefix + key) !== null;
      localStorage.removeItem(prefix + key);
      return { key, deleted: existed, shared: false };
    },
    async list(searchPrefix = "") {
      const keys = Object.keys(localStorage)
        .filter((k) => k.startsWith(prefix + searchPrefix))
        .map((k) => k.slice(prefix.length));
      return { keys, prefix: searchPrefix, shared: false };
    },
  };
}
