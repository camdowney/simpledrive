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

// Installed, the status bar is painted from this; it has to be right before the bar first shows.
// --surface, not --bg: the bar butts against a view's top bar, and a seam there reads as a gap.
document.getElementById("theme-color").content =
  document.documentElement.dataset.theme === "dark" ? "#202226" : "#ffffff"
