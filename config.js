/* zerox.gg settings.
   Hosted on the Cloudflare Worker (recommended): leave api empty - the backend is the same site.
   Frontend on GitHub Pages instead: put your Worker address here, e.g.
     api: "https://zerox-gg.YOUR-NAME.workers.dev"
   base "auto" detects "/" or "/repo-name/" by itself. */
window.GLITCH = {
  api: "",
  base: "auto",
  __loaded: true
};
