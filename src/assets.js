// Static assets for the web UI, imported as files so they are embedded in compiled
// executables and served from the same /static/... URLs in every mode.
//
// Deliberately not using Bun's HTML-import bundling: in `bun run` mode it emits asset
// URLs relative to the *working directory*, which breaks as soon as the app runs with
// a data directory (IRCBOOK_DATA) that is not the project directory.
import indexHtml from "../public/index.html" with { type: "file" };
import appJs from "../public/app.js" with { type: "file" };
import stylesCss from "../public/styles.css" with { type: "file" };
import faviconSvg from "../public/favicon.svg" with { type: "file" };

/** URL path -> { file path (real or embedded), content type } */
export const assets = {
  "/": { path: indexHtml, type: "text/html; charset=utf-8" },
  "/static/app.js": { path: appJs, type: "text/javascript; charset=utf-8" },
  "/static/styles.css": { path: stylesCss, type: "text/css; charset=utf-8" },
  "/static/favicon.svg": { path: faviconSvg, type: "image/svg+xml" },
};
