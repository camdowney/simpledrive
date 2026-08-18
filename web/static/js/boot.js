// Runs in <head> before paint so password managers see the login form; authed paints nothing.
// A share link has no account to sign into, so it must never flash the form at its visitor.
if (
  document.cookie.split("; ").indexOf("sd_authed=1") === -1 &&
  !window.location.pathname.startsWith("/s/")
)
  document.documentElement.classList.add("boot-login")

// Installed, a tab bar stands in for the header's storage button; set before the header paints.
if (matchMedia("(display-mode: standalone)").matches || navigator.standalone)
  document.documentElement.classList.add("installed")

// Resolved here rather than in app.js so the first paint isn't a flash of the wrong theme.
document.documentElement.dataset.theme = (() => {
  let saved
  try {
    saved = localStorage.getItem("theme")
  } catch {}
  if (saved === "light" || saved === "dark") return saved
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
})()

// Installed, iOS samples body's background for the status bar; it must be right before it paints.
// --surface, not --bg: the strip butts against a view's top bar, and a seam there reads as a gap.
const chromeColor = (() => {
  const dark = document.documentElement.dataset.theme === "dark"
  if (document.documentElement.classList.contains("boot-login")) return dark ? "#16171a" : "#f5f5f5"
  return dark ? "#202226" : "#ffffff"
})()
document.getElementById("theme-color").content = chromeColor
document.documentElement.style.setProperty("--chrome-bg", chromeColor)
