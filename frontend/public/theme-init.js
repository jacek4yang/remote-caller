// Applied before the application bundle paints so the first frame already
// matches the saved theme. CSP allows only same-origin scripts; this file is
// served from /theme-init.js by the Rust static server / Nginx.
(function () {
  var dark = true;
  try {
    var stored = localStorage.getItem('rc:theme');
    if (stored === 'light' || stored === 'dark' || stored === 'system') {
      dark = stored === 'dark'
        || (stored === 'system' && !window.matchMedia('(prefers-color-scheme: light)').matches);
    } else if (window.matchMedia) {
      // First visit: follow the operating system before first paint.
      dark = !window.matchMedia('(prefers-color-scheme: light)').matches;
    }
  } catch (error) {
    dark = true;
  }
  var root = document.documentElement;
  root.dataset.theme = dark ? 'dark' : 'light';
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#070a12' : '#f4f6f9');
  try {
    var locale = localStorage.getItem('rc:locale');
    if (locale === 'zh-CN') root.lang = 'zh-CN';
  } catch (error) {
    // fall back to the html lang attribute
  }
}());
