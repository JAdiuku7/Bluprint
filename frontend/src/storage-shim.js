
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
