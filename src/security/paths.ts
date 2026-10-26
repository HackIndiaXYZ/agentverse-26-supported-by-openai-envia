import path from "node:path";

export function safeRelativePath(input: unknown): string | null {
  if (typeof input !== "string" || input.trim().length === 0) return null;
  const posix = input.replace(/\\/g, "/");
  const segments = posix.split("/");
  if (segments.some((segment) => segment === "..")) return null;
  if (posix.startsWith("/") || /^[a-zA-Z]:/.test(posix)) return null;
  const normalized = path.posix.normalize(posix);
  const normalizedSegments = normalized.split("/").filter(Boolean);
  if (normalizedSegments.includes("..")) return null;
  if (normalized === "" || normalized === ".") return null;
  return normalizedSegments.join("/");
}

export function isPathInside(root: string, target: string): boolean {
  const rootResolved = path.resolve(root);
  const targetResolved = path.resolve(target);
  const rootKey = process.platform === "win32" ? rootResolved.toLowerCase() : rootResolved;
  const targetKey = process.platform === "win32" ? targetResolved.toLowerCase() : targetResolved;
  const relative = path.relative(rootKey, targetKey);
  if (relative === "") return true;
  if (path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep).filter(Boolean);
  return !segments.includes("..");
}

export function resolveInside(root: string, relative: string): string | null {
  const safe = safeRelativePath(relative);
  if (!safe) return null;
  const resolved = path.resolve(root, ...safe.split("/"));
  if (!isPathInside(root, resolved)) return null;
  return resolved;
}