// DSH moved from registered settings namespaces to profile-entry forms.
// Adapt by capability, never by package version: the old build exposes
// installSection/get, the current one only describe/update/mutate.
// Used for the official provider catalog and for writes to the official
// llm-pi-ai entry. The theme plugin's own model choice lives in its own
// settings file, because this plugin's Config entry is owned by a profile
// `insert:` patch row that the DSH config editor refuses to rewrite.
export function settingsBridge(raw) {
  if (!raw) return undefined;
  const read = ns => typeof raw.get === 'function' ? raw.get(ns) : raw.describe({ redactSecrets: true }).find(d => d.ns === ns)?.value;
  return {
    get: read,
    update: (ns, ...args) => raw.update(ns, ...args),
    mutate: (ns, ...args) => raw.mutate(ns, ...args)
  };
}
export function liveValue(value) { return value && typeof value.get === 'function' ? value.get() : value; }
