// Runs in <head> before paint so password managers see the login form; authed paints nothing.
// A share link has no account to sign into, so it must never flash the form at its visitor.
if (
  document.cookie.split("; ").indexOf("sd_authed=1") === -1 &&
  !window.location.pathname.startsWith("/s/")
)
  document.documentElement.classList.add("boot-login")

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
document.getElementById("theme-color").content =
  document.documentElement.dataset.theme === "dark" ? "#16171a" : "#f5f5f5"
