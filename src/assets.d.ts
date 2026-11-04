export interface Asset {
  path: string;
  type: string;
}
export const assets: Record<"/" | "/static/app.js" | "/static/styles.css" | "/static/favicon.svg", Asset>;
