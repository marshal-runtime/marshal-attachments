export const dependencySections = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];

export const productionDependencySections = dependencySections.slice(0, 3);

const forbiddenProtocols = new Set([
  "bitbucket",
  "catalog",
  "file",
  "git",
  "git+file",
  "git+http",
  "git+https",
  "git+ssh",
  "github",
  "gitlab",
  "http",
  "https",
  "link",
  "patch",
  "path",
  "portal",
  "ssh",
  "workspace",
]);

export function dependencyReferenceFailure(range, { allowWorkspace = false } = {}) {
  if (typeof range !== "string" || range.length === 0) return "range must be a non-empty string";
  if (range !== range.trim()) return "range must not contain surrounding whitespace";
  if (allowWorkspace && range === "workspace:*") return undefined;

  if (
    /^(?:[A-Za-z]:[\\/]|\\\\|[\\/]|~[\\/]|\.{1,2}[\\/]|packages[\\/])/i.test(range)
    || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(range)
  ) {
    return "path and sibling references are forbidden";
  }

  if (/\.(?:tgz|tar\.gz)(?:$|[?#])/i.test(range)) {
    return "tarball references are forbidden";
  }

  const protocol = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(range)?.[1]?.toLowerCase();
  if (protocol && forbiddenProtocols.has(protocol)) {
    return `${protocol}: references are forbidden`;
  }

  return undefined;
}

export function isExactVersion(value) {
  return typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value);
}
