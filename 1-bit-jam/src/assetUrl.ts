// src/assetUrl.ts
export const assetUrl = (pathFromPublicRoot: string) => {
  const base = import.meta.env.BASE_URL || "./";
  const p = pathFromPublicRoot.replace(/^\/+/, ""); // strip leading slashes
  return base + p;
};
