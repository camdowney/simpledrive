"use strict"

// ─── File search ──────────────────────────────────────────────────────────────

// One letter would walk the whole drive on the first keystroke and match nearly everything.
const SEARCH_MIN_CHARS = 2
const SEARCH_DEBOUNCE_MS = 250
const SEARCH_IDLE_NOTE = "Type at least two characters."

// Remembered across opens: a habitual scope shouldn't have to be re-picked every search.
let searchScope = "folder"

const searchBase = () => (searchScope === "root" ? homePath() : state.currentPath)

const baseName = (p) => p.slice(p.lastIndexOf("/") + 1)
const dirName = (p) => p.slice(0, p.lastIndexOf("/")) || "/"

// Named the way the breadcrumb names it, so the two agree.
const hitFolderLabel = (hitPath) => {
  const dir = dirName(hitPath)
  const home = homePath()
  if (dir === home) return state.share ? state.share.name : "Home"
  const rel = home === "/" ? dir.slice(1) : dir.slice(home.length + 1)
  // Search results are the one place the trash's real name would otherwise still show through.
  return rel === TRASH_DIR
    ? TRASH_LABEL
    : rel.replace(new RegExp(`^${TRASH_DIR}/`), TRASH_LABEL + "/")
}

// A search hit carries no isTrash flag, so its path is what labels it like the browser does.
const decorateHit = (hit) =>
  hit.path === `/${TRASH_DIR}` ? { ...hit, isTrash: true, name: TRASH_LABEL } : hit

const markMatch = (name, q) => {
  const i = name.toLowerCase().indexOf(q.toLowerCase())
  if (i < 0) return esc(name)
  const end = i + q.length
  return `${esc(name.slice(0, i))}<mark>${esc(name.slice(i, end))}</mark>${esc(name.slice(end))}`
}

// No thumbnails: a hit is a place in the drive, and a row per network image would make it crawl.
const searchHitHtml = (hit, q) => `
  <button type="button" class="search-hit" data-path="${esc(hit.path)}" data-dir="${!!hit.isDir}">
    <span class="search-hit-icon">${fileIcon(hit)}</span>
    <span class="search-hit-text">
      <span class="search-hit-name">${markMatch(hit.name, q)}</span>
      <span class="search-hit-folder">${esc(hitFolderLabel(hit.path))}</span>
    </span>
    <span class="search-hit-meta">${hit.isDir ? "" : fmtSize(hit.size)}</span>
  </button>`

// A hit can be anywhere, so open it by landing in its folder first: that listing is what feeds
// the viewer, the editor and the breadcrumb.
const goToHit = async (path, isDir) => {
  if (isDir) {
    navigate(path)
    return
  }
  await navigate(dirName(path))
  // allEntries, not entries: a tag filter shouldn't swallow a file the user just picked by name.
  const entry = state.allEntries.find((e) => e.name === baseName(path))
  if (entry) openEntry(entry)
}

const showFileSearch = () => {
  // At home both scopes resolve to the same base; hide the choice but keep the remembered scope.
  const atHome = state.currentPath === homePath()
  const folderLabel = atHome ? "" : baseName(state.currentPath)

  const scopeHtml = atHome
    ? ""
    : `
    <div class="file-search-scope">
      <span class="file-search-scope-label" id="file-search-scope-label"></span>
      <button type="button" class="switch" id="file-search-global" role="switch">
        <span>Global</span>
        <span class="switch-track"></span>
      </button>
    </div>`

  const cleanup = showExtraModal({
    title: "Search",
    wide: true,
    okLabel: "Close",
    closeOnly: true,
    okClass: "btn btn-subtle",
    extraHtml: `
    <div class="file-search">
      <div class="file-search-bar">
        <svg class="file-search-icon" aria-hidden="true"><use href="#icon-search" /></svg>
        <input id="file-search-input" class="file-search-input" placeholder="Name contains…"
          autocomplete="off" spellcheck="false" aria-label="Search file names" />
      </div>
      ${scopeHtml}
      <div class="file-search-results" id="file-search-results"></div>
    </div>`,
    onOk: () => close(),
  })

  const input = document.getElementById("file-search-input")
  const results = document.getElementById("file-search-results")
  let timer = null
  let ctrl = null

  const close = () => {
    clearTimeout(timer)
    ctrl?.abort()
    cleanup()
  }
  // Owning both dismissals keeps a closed dialog from leaving a query in flight behind it.
  const backdrop = document.getElementById("modal-backdrop")
  backdrop.onclick = (e) => {
    if (e.target === backdrop) close()
  }

  const note = (text) => {
    results.innerHTML = `<p class="file-search-note">${esc(text)}</p>`
  }

  const globalBtn = document.getElementById("file-search-global")

  // The switch alone doesn't say what it's global against, so the label names the subtree in play.
  const renderScope = () => {
    if (!globalBtn) return
    const isGlobal = searchScope === "root"
    globalBtn.setAttribute("aria-checked", isGlobal)
    document.getElementById("file-search-scope-label").textContent = isGlobal
      ? "Searching everywhere"
      : `Searching in ${folderLabel}`
  }
  renderScope()

  const run = async () => {
    const q = input.value.trim()
    ctrl?.abort()
    if (q.length < SEARCH_MIN_CHARS) {
      note(SEARCH_IDLE_NOTE)
      return
    }
    ctrl = new AbortController()
    const signal = ctrl.signal
    // Keep the previous hits up while the next query runs; a blank list reads as "nothing found".
    if (!results.querySelector(".search-hit")) note("Searching…")
    results.classList.add("stale")

    const params = new URLSearchParams({ path: searchBase(), q })
    if (state.showHidden) params.set("hidden", "1")
    let data
    try {
      data = await api("GET", `/api/files/search?${params}`, null, false, signal)
    } catch (e) {
      if (signal.aborted || !results.isConnected) return
      results.classList.remove("stale")
      note(`Search failed: ${e.message}`)
      return
    }
    if (signal.aborted || !results.isConnected || !data) return
    results.classList.remove("stale")
    if (!data.hits.length) {
      note(`Nothing matches “${q}”`)
      return
    }
    const more = data.truncated
      ? `<p class="file-search-note">First ${data.hits.length} matches — narrow the search for the rest.</p>`
      : ""
    results.innerHTML = data.hits.map((hit) => searchHitHtml(decorateHit(hit), q)).join("") + more
    warmVisibleGains(data.hits, (h) => h.path)
  }

  const queueRun = () => {
    clearTimeout(timer)
    timer = setTimeout(run, SEARCH_DEBOUNCE_MS)
  }

  input.oninput = queueRun
  if (globalBtn)
    globalBtn.onclick = () => {
      searchScope = searchScope === "root" ? "folder" : "root"
      renderScope()
      run()
    }

  results.onclick = (e) => {
    const row = e.target.closest(".search-hit")
    if (!row) return
    close()
    goToHit(row.dataset.path, row.dataset.dir === "true")
  }

  const step = (delta) => {
    const rows = [...results.querySelectorAll(".search-hit")]
    if (!rows.length) return
    const at = rows.findIndex((r) => r.classList.contains("current"))
    const next = Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + delta))
    rows.forEach((r) => r.classList.remove("current"))
    rows[next].classList.add("current")
    rows[next].scrollIntoView({ block: "nearest" })
  }

  // Owns the dialog's keys: the shell's Enter would close on the keystroke that opens a hit.
  document.getElementById("modal-extra").onkeydown = (e) => {
    if (e.key === "Escape") {
      close()
      return
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      step(e.key === "ArrowDown" ? 1 : -1)
      return
    }
    if (e.key !== "Enter") return
    // The scope switch is a button: Enter has to toggle it, not open the top hit.
    if (e.target.closest(".switch")) return
    e.preventDefault()
    const row = results.querySelector(".search-hit.current") || results.querySelector(".search-hit")
    if (!row) return
    close()
    goToHit(row.dataset.path, row.dataset.dir === "true")
  }

  note(SEARCH_IDLE_NOTE)
  input.focus()
}

const showLogin = () => {
  // Clear the boot hint so a refresh at login never optimistically flashes the app.
  document.cookie = "sd_authed=; path=/; max-age=0; samesite=strict"
  document.getElementById("login-view").classList.remove("hidden")
  document.getElementById("app-view").classList.add("hidden")
  teardownPreview()
}

const showShareGone = () => {
  document.getElementById("login-view").classList.add("hidden")
  document.getElementById("app-view").classList.add("hidden")
  document.getElementById("share-gone").classList.remove("hidden")
  teardownPreview()
}

// Hide what a link's holder has no business seeing; view-only additionally loses every mutation.
const applyShareChrome = () => {
  const hide = (sel) => document.querySelectorAll(sel).forEach((el) => el.classList.add("hidden"))
  hide(".js-logout")
  hide("#new-s3-btn")
  hide("#sort-tags")
  hide("#options-tags-btn")
  hide("#editor-tags-btn")
  hide("#crumb-tags-btn")
  hide("#options-share-btn")
  hide("#preview-share-btn")
  hide("#editor-share-btn")
  hide("#crumb-share-btn")
  hide(".js-storage")
  if (!canEdit()) {
    hide("#options-move-btn")
    hide("#options-copy-btn")
    hide(".new-popover-wrap")
    hide(".upload-popover-wrap")
    hide("#toolbar-sep")
    hide("#rename-btn")
    hide("#delete-btn")
    hide("#crumb-rename-btn")
    hide("#crumb-delete-btn")
    hide("#preview-rename-btn")
    hide("#preview-delete-btn")
    hide("#editor-rename-btn")
    hide("#editor-delete-btn")
    hide("#editor-save-btn")
  }
  hide("#preview-tool-btn")
  hide("#preview-level-btn")
  // Back would land on the folder the file sits in, which is the owner's and not the link's.
  if (sharedFile()) {
    hide("#preview-back-btn")
    hide("#editor-back-btn")
  }
}

// Leaves every view hidden; the route decides which one appears, so no chrome flashes out.
const showApp = () => {
  document.getElementById("login-view").classList.add("hidden")
  document.getElementById("app-view").classList.remove("hidden")
}

// Nothing routed us anywhere (listing failed, missing file, external PDF); fall back to browsing.
const ensureView = () => {
  const hidden = (id) => document.getElementById(id).classList.contains("hidden")
  if (hidden("app-view")) return
  if (hidden("browser-view") && hidden("editor-view") && hidden("preview-view")) {
    showBrowser({ pushHash: false })
  }
}

// Decoded current hash, defaulting to home; location.hash is percent-encoded.
const currentHashPath = () => {
  const raw = window.location.hash.slice(1)
  if (!raw) return homePath()
  let path
  try {
    path = decodeURIComponent(raw) || homePath()
  } catch {
    path = raw
  }
  if (path === "/") return homePath()
  // Share hashes are root-relative; absolute hashes from older links still resolve.
  if (!withinHome(path)) path = homePath() + (path.startsWith("/") ? path : "/" + path)
  return path
}

// One traversal can fire both popstate and hashchange; skip the echo of an already-handled URL.
let handledUrl = ""

// Shares keep the slash out of the root URL: /s/T at home, /s/T/#/sub inside a folder.
const shareBasePath = () => window.location.pathname.replace(/\/+$/, "")

const homeUrl = () =>
  (state.share ? shareBasePath() : window.location.pathname) + window.location.search

// Share hashes drop the root prefix: the token already names that folder.
const hashUrl = (path) => {
  if (!state.share) return "#" + path
  const rel = state.share.root === "/" ? path : path.slice(state.share.root.length) || "/"
  return shareBasePath() + "/" + window.location.search + "#" + rel
}

// Home normalizes to a hashless URL so it matches location.hash and doesn't stack dup entries.
const pushPathHash = (path) => {
  if (currentHashPath() === path) return false
  history.pushState(null, "", path === homePath() ? homeUrl() : hashUrl(path))
  handledUrl = window.location.href
  return true
}

// Rewrite the hash in place so the preview session stays one history entry.
const replacePathHash = (path) => {
  history.replaceState(null, "", path === homePath() ? homeUrl() : hashUrl(path))
  handledUrl = window.location.href
}

// Silences the viewer but leaves its chrome up: back re-routes a frame or two after we leave.
const silencePreview = () => {
  // Runs before the players clear, so the verdict reads the song's position; leaving is no skip.
  settleTagging(false, { keepOnly: true })
  endAudioSession()
  clearMediaSession()
  for (const player of document.querySelectorAll("#preview-body video, #preview-body audio"))
    player.pause()
  // A swipe still settling would otherwise page back into the viewer we just left.
  state.previewSliding = false
  state.previewType = null
}

// Every exit from the viewer runs this: hiding, or even detaching, doesn't reliably stop playback.
const teardownPreview = () => {
  silencePreview()
  const body = document.getElementById("preview-body")
  for (const player of body.querySelectorAll("video, audio")) {
    player.removeAttribute("src")
    player.replaceChildren()
    player.load() // aborts the in-flight media fetch too
  }
  body.innerHTML = ""
  body.style.transform = ""
  resetZoom()
  const bar = document.getElementById("preview-tagbar")
  bar.innerHTML = ""
  bar.classList.remove("has-audio")
  document.getElementById("preview-tagslot").innerHTML = ""
  document.getElementById("preview-options").classList.remove("open")
  document
    .getElementById("preview-view")
    .classList.remove("chrome-hidden", "has-embed", "has-photo")
}

const showBrowser = ({ pushHash = true } = {}) => {
  document.getElementById("browser-view").classList.remove("hidden")
  document.getElementById("editor-view").classList.add("hidden")
  document.getElementById("preview-view").classList.add("hidden")
  teardownPreview()
  if (state.mdeInstance) {
    state.mdeInstance.destroy()
    state.mdeInstance = null
  }
  if (pushHash) pushPathHash(state.currentPath)
}

const showEditorView = () => {
  document.getElementById("browser-view").classList.add("hidden")
  document.getElementById("editor-view").classList.remove("hidden")
  document.getElementById("preview-view").classList.add("hidden")
  teardownPreview()
}

const showPreviewView = () => {
  document.getElementById("browser-view").classList.add("hidden")
  document.getElementById("editor-view").classList.add("hidden")
  document.getElementById("preview-view").classList.remove("hidden")
}

// ─── Breadcrumb ───────────────────────────────────────────────────────────────

const renderBreadcrumb = () => {
  const bc = document.getElementById("breadcrumb")

  // A link's holder gets the shared folder as their home; the path above it isn't theirs to see.
  const home = homePath()
  const label = state.share ? state.share.name : "Home"
  const below = home === "/" ? state.currentPath : state.currentPath.slice(home.length)
  const parts = below.replace(/^\/+/, "").split("/").filter(Boolean)
  const atRoot = parts.length === 0
  // The trash offers none of the folder actions, so it gets the root's inert crumb instead.
  const inert = atRoot || atOrInTrash(state.currentPath)
  // A trashed path keeps its dotfolder name; only the crumb reads as "Trash".
  const partLabel = (p) => (p === TRASH_DIR ? TRASH_LABEL : p)
  const crumb = (name) =>
    inert
      ? `<span class="current"><span class="crumb-name">${esc(name)}</span></span>`
      : `<button type="button" class="current" id="crumb-menu-btn" aria-haspopup="menu"
           aria-controls="crumb-popover" aria-expanded="false" aria-label="Folder options">
           <span class="crumb-name">${esc(name)}</span>
           <svg class="crumb-chevron" aria-hidden="true"><use href="#icon-chevron-down" /></svg>
         </button>`

  let html = atRoot ? crumb(label) : `<a href="#" data-path="${esc(home)}">${esc(label)}</a>`
  let built = home === "/" ? "" : home
  for (let i = 0; i < parts.length; i++) {
    built += "/" + parts[i]
    html += `<span class="sep">/</span>`
    if (i === parts.length - 1) {
      html += crumb(partLabel(parts[i]))
    } else {
      html += `<a href="#" data-path="${esc(built)}">${esc(partLabel(parts[i]))}</a>`
    }
  }
  bc.innerHTML = html
  document.getElementById("crumb-popover").classList.remove("open")
  // A folder inside a vault is an index entry, not a path: the items needing one are out.
  const inVaultSub = state.inVault && state.currentPath !== state.vaultRoot
  for (const id of ["crumb-tags-btn", "crumb-share-btn", "crumb-download-btn"]) {
    document.getElementById(id).disabled = inVaultSub
  }
}

// The open folder's own entry lives in its parent's listing, which the browser never loaded.
const openFolderEntry = async () => {
  const dir = parentPath(state.currentPath)
  const name = state.currentPath.slice(dir === "/" ? 1 : dir.length + 1)
  // A vault subfolder is in no listing the server can give; its parent's comes from the index.
  if (state.inVault && state.currentPath !== state.vaultRoot) {
    const entry = Vault.list(vaultSubOf(dir)).find((e) => e.name === name && e.isDir)
    if (entry) return { ...entry, dir }
    toast("Folder not found", true)
    return null
  }
  try {
    const data = await api("GET", `/api/files?path=${encodeURIComponent(dir)}`)
    const entry = (data?.entries || []).find((e) => e.name === name && e.isDir)
    if (entry) return { ...entry, dir }
    toast("Folder not found", true)
  } catch (e) {
    toast(e.message, true)
  }
  return null
}

// Bound once in init: delegation keeps re-renders from stacking listeners on #breadcrumb.
const wireBreadcrumb = () => {
  const bc = document.getElementById("breadcrumb")
  const popover = document.getElementById("crumb-popover")
  // A crumb opens on the click its press begins, so the listing has that press to travel in.
  bc.addEventListener("pointerdown", (e) => {
    const a = e.target.closest("a[data-path]")
    if (a) prefetchListing(a.dataset.path)
  })
  bc.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-path]")
    if (a) {
      e.preventDefault()
      navigate(a.dataset.path)
      return
    }
    const btn = e.target.closest("#crumb-menu-btn")
    if (!btn) return
    e.stopPropagation()
    closePopovers(popover)
    const open = !popover.classList.contains("open")
    popover.classList.toggle("open", open)
    btn.setAttribute("aria-expanded", String(open))
    // Anchored to the row, which is both wider and taller than the crumb: track the crumb itself.
    if (open) {
      const room = popover.parentElement.offsetWidth - popover.offsetWidth
      popover.style.left = `${Math.max(0, Math.min(btn.offsetLeft, room))}px`
      // Off the crumb's text: it has no border, so its padding would read as extra gap.
      const pad = parseFloat(getComputedStyle(btn).paddingBottom)
      popover.style.top = `calc(${btn.offsetTop + btn.offsetHeight - pad}px + var(--popover-gap))`
    }
  })
  // Every item here acts and is done, so the menu closes on any click within it.
  document.addEventListener("click", () => {
    popover.classList.remove("open")
    document.getElementById("crumb-menu-btn")?.setAttribute("aria-expanded", "false")
  })

  const act = (id, fn) =>
    document.getElementById(id).addEventListener("click", async () => {
      const entry = await openFolderEntry()
      if (entry) fn(entry)
    })
  act("crumb-rename-btn", showRename)
  act("crumb-tags-btn", showTagsDialog)
  act("crumb-share-btn", showShareDialog)
  act("crumb-details-btn", showDetails)
  act("crumb-delete-btn", (entry) =>
    deleteEntries([entry], { after: () => navigate(entryDir(entry)) })
  )
  document
    .getElementById("crumb-download-btn")
    .addEventListener("click", () => downloadZip([state.currentPath]))
}

const esc = (s) => {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}
