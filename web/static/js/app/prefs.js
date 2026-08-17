"use strict"

// ─── Storage ──────────────────────────────────────────────────────────────────

// Mirrors the server's families, in the order it reports them.
const STORAGE_TYPES = [
  { key: "documents", label: "Documents" },
  { key: "photos", label: "Photos" },
  { key: "videos", label: "Videos" },
  { key: "audio", label: "Audio" },
  { key: "archives", label: "Archives" },
  { key: "other", label: "Other" },
]

// Every family gets a row whether or not it holds anything, so the walk can't resize the dialog.
const typeRowHtml = (t, use, total) => {
  const share = use && total ? Math.round((use.bytes / total) * 100) : 0
  return `
  <div class="storage-type">
    <span class="storage-swatch storage-cat-${t.key}"></span>
    <span class="storage-type-name">${t.label}</span>
    <span class="storage-type-size">${use ? fmtSize(use.bytes) : "—"}</span>
    <span class="storage-type-share">${use ? share + "%" : ""}</span>
  </div>`
}

const typeSegHtml = (t, use, total) =>
  !use || !use.bytes || !total
    ? ""
    : `<span class="storage-seg storage-cat-${t.key}"
         style="width:${(use.bytes / total) * 100}%"></span>`

// Classes, not ids: the dialog and the installed tab each hold a copy of this.
const storageHtml = () => `
  <div class="storage-meter">
    <div class="storage-bar"></div>
    <p class="storage-line">Reading the disk…</p>
  </div>
  <p class="storage-heading">By type</p>
  <div class="storage-bar storage-types"></div>
  <div class="storage-legend">
    ${STORAGE_TYPES.map((t) => typeRowHtml(t, null, 0)).join("")}
  </div>
  <p class="storage-summary"></p>`

const fillStorage = (root) => {
  root.innerHTML = storageHtml()

  const meterEl = root.querySelector(".storage-meter")
  const typesEl = root.querySelector(".storage-types")
  const legendEl = root.querySelector(".storage-legend")
  const noteEl = root.querySelector(".storage-summary")

  api("GET", "/api/usage")
    .then((u) => {
      if (!u) return
      if (!u.available) {
        meterEl.innerHTML = `<p class="storage-note">This system doesn't report free space.</p>`
        return
      }
      const pct = u.total ? Math.min(100, Math.round((u.used / u.total) * 100)) : 0
      meterEl.innerHTML = `
        <div class="storage-bar"><div class="storage-bar-fill" style="width:${pct}%"></div></div>
        <p class="storage-line">
          <span><strong>${fmtSize(u.free)}</strong> free</span>
          <span>${fmtSize(u.used)} of ${fmtSize(u.total)} used</span>
        </p>`
    })
    .catch((e) => {
      meterEl.innerHTML = `<p class="storage-note">${esc(e.message)}</p>`
    })

  api("GET", `/api/usage/breakdown?path=${encodeURIComponent(homePath())}`)
    .then((d) => {
      if (!d) return
      const by = Object.fromEntries((d.categories || []).map((c) => [c.key, c]))
      const total = d.bytes || 0
      typesEl.innerHTML = STORAGE_TYPES.map((t) => typeSegHtml(t, by[t.key], total)).join("")
      legendEl.innerHTML = STORAGE_TYPES.map((t) => typeRowHtml(t, by[t.key], total)).join("")
      if (!total) {
        noteEl.textContent = "Nothing stored yet."
        return
      }
      const sofar = d.partial ? " so far — the drive was too deep to finish walking" : ""
      noteEl.innerHTML = `
        <span>${(d.files || 0).toLocaleString()} files</span>
        <span>${fmtSize(total)}${sofar}</span>`
    })
    .catch((e) => {
      noteEl.textContent = e.message
    })
}

const showStorage = () => {
  const cleanup = showExtraModal({
    title: "Storage",
    okLabel: "Close",
    closeOnly: true,
    okClass: "btn btn-subtle",
    extraHtml: `<div class="storage"></div>`,
    onOk: () => cleanup(),
  })
  fillStorage(document.querySelector("#modal-extra .storage"))
}

// Credentials are write-only: POSTed once, stored server-side, never returned by /api/mounts.
const showS3Mount = () => {
  const field = (id, label, { type = "text", placeholder = "" } = {}) => `
    <div class="form-field">
      <label class="form-label" for="${id}">${label}</label>
      <input class="form-input" id="${id}" type="${type}" placeholder="${esc(placeholder)}"
        autocomplete="off" autocapitalize="none" autocorrect="off" spellcheck="false" />
    </div>`

  const cleanup = showExtraModal({
    title: "Connect S3 bucket",
    extraHtml: `
    <div class="form-fields">
      ${field("s3-name", "Folder name", { placeholder: "Photos" })}
      ${field("s3-bucket", "Bucket", { placeholder: "my-bucket" })}
      ${field("s3-endpoint", "Endpoint", { placeholder: "B2 / R2 / MinIO host (blank for AWS)" })}
      ${field("s3-region", "Region", { placeholder: "us-east-1 (auto for B2 / R2 endpoints)" })}
      ${field("s3-key", "Access key ID")}
      ${field("s3-secret", "Secret access key", { type: "password" })}
      ${field("s3-prefix", "Prefix", { placeholder: "key prefix (optional)" })}
    </div>
    <p class="form-warning">
      <strong>Warning:</strong> Bucket credentials are stored on the server, so whatever can reach the server can reach the bucket. Use a key scoped to this one bucket rather than account-wide credentials.
    </p>`,
    okLabel: "Connect",
    onOk: () => submit(),
  })
  document.getElementById("s3-name").focus()

  // Connecting probes the bucket, so it isn't instant; block repeat submits while it runs.
  let connecting = false
  const submit = async () => {
    if (connecting) return
    const val = (id) => document.getElementById(id).value.trim()
    const body = {
      name: val("s3-name"),
      bucket: val("s3-bucket"),
      region: val("s3-region"),
      prefix: val("s3-prefix"),
      endpoint: val("s3-endpoint"),
      accessKeyId: val("s3-key"),
      // Not trimmed: leading/trailing whitespace is legal in a secret.
      secretAccessKey: document.getElementById("s3-secret").value,
    }
    const okBtn = document.getElementById("modal-ok")
    connecting = true
    okBtn.textContent = "Connecting..."
    try {
      await api("POST", "/api/mounts", body)
    } catch (e) {
      toast(e.message, true)
      connecting = false
      okBtn.textContent = "Connect"
      return
    }
    cleanup()
    toast(`Connected “${body.name}”`)
    navigate(state.currentPath)
  }
}

// ─── View Management ──────────────────────────────────────────────────────────

const setViewMode = (mode) => {
  state.viewMode = mode
  state.viewModes[state.currentPath] = mode
  savePrefs()
}

const setSort = (by, dir) => {
  state.sortBy = by
  state.sortDir = dir
  state.sorts[state.currentPath] = { by, dir }
  savePrefs()
}

const setGrouping = (grouping) => {
  state.grouping = grouping
  state.groupings[state.currentPath] = grouping
  savePrefs()
}

const setShowHidden = (show) => {
  state.showHidden = show
  savePrefs()
}

const systemTheme = matchMedia("(prefers-color-scheme: dark)")

// Installed, iOS paints the status bar from this, so it has to match whatever sits directly below.
const statusBarColor = () => {
  const shown = (id) => !document.getElementById(id).classList.contains("hidden")
  const dark = document.documentElement.dataset.theme === "dark"
  // Ordered by what owns the top of the screen: the login page's ground, the viewer's black,
  // then --surface, which every view's top bar is painted in.
  if (!shown("app-view")) return dark ? "#16171a" : "#f5f5f5"
  if (shown("preview-view")) return "#111"
  return dark ? "#202226" : "#ffffff"
}

const paintStatusBar = () => {
  document.getElementById("theme-color").content = statusBarColor()
}

// A null state.theme follows the OS; boot.js applies the same resolution before first paint.
const applyTheme = () => {
  document.documentElement.dataset.theme = state.theme || (systemTheme.matches ? "dark" : "light")
  paintStatusBar()
}

const setTheme = (theme) => {
  state.theme = theme
  applyTheme()
  localStorage.setItem("theme", theme)
}

// Any one selected tag is enough; a folder also passes on a tagged descendant.
const matchesTagFilter = (entry, tagged) => {
  if (!tagged) return true
  const path = relPath(entry.name)
  if (tagged.includes(path)) return true
  return entry.isDir && tagged.some((p) => p.startsWith(path + "/"))
}

const applyEntryFilters = () => {
  const tagged = state.tagFilter.size
    ? Object.keys(state.fileTags).filter((p) =>
        state.fileTags[p].some((id) => state.tagFilter.has(id))
      )
    : null
  state.entries = state.allEntries.filter(
    (e) => (state.showHidden || !e.name.startsWith(".")) && matchesTagFilter(e, tagged)
  )
}

const prefsBlob = () => ({
  viewModes: state.viewModes,
  sorts: state.sorts,
  groupings: state.groupings,
  showHidden: state.showHidden,
  audioMode: state.audioMode,
  audioMixes: state.audioMixes,
  audioNormalize: state.audioNormalize,
})

let prefsSyncTimer = null
// Cache locally for instant loads, then debounce-push to the server for other devices.
const savePrefs = () => {
  const blob = prefsBlob()
  localStorage.setItem("prefs", JSON.stringify(blob))
  // A share visitor has no owner session; the PUT would 401 and tear down the page.
  if (state.share) return
  clearTimeout(prefsSyncTimer)
  prefsSyncTimer = setTimeout(() => api("PUT", "/api/prefs", blob).catch(() => {}), 400)
}

const syncPrefsFromServer = async () => {
  const blob = await api("GET", "/api/prefs").catch(() => null)
  if (!blob || typeof blob !== "object") return
  const applied = JSON.stringify([
    state.viewMode,
    state.sortBy,
    state.sortDir,
    state.grouping,
    state.showHidden,
  ])
  state.viewModes = blob.viewModes || {}
  state.sorts = blob.sorts || {}
  state.groupings = blob.groupings || {}
  state.showHidden = blob.showHidden === true
  state.audioMode = readAudioMode(blob.audioMode)
  state.audioMixes = readAudioMixes(blob.audioMixes)
  state.audioNormalize = blob.audioNormalize === true
  localStorage.setItem("prefs", JSON.stringify(prefsBlob()))
  const browsing = !document.getElementById("browser-view").classList.contains("hidden")
  if (browsing && state.allEntries.length) {
    loadFolderPrefs()
    updateViewToggle()
    updateSortToggle()
    // Re-render (reloads thumbnails) only when server prefs actually change the view.
    if (
      JSON.stringify([
        state.viewMode,
        state.sortBy,
        state.sortDir,
        state.grouping,
        state.showHidden,
      ]) !== applied
    ) {
      applyEntryFilters()
      sortEntries()
      renderFiles()
    }
  }
}

// A dotfile keeps its whole name as the stem.
const splitFileName = (name) => {
  const lower = name.toLowerCase()
  const dot = lower.lastIndexOf(".")
  return dot > 0 ? [lower.slice(0, dot), lower.slice(dot)] : [lower, ""]
}

// Extension weighed apart from the stem so "photo-resized.jpg" follows "photo.jpg"; server agrees.
const compareFileNames = (a, b) => {
  const [as, ax] = splitFileName(a)
  const [bs, bx] = splitFileName(b)
  if (as !== bs) return as < bs ? -1 : 1
  return ax < bx ? -1 : ax > bx ? 1 : 0
}

const sortEntries = () => {
  const dir = state.sortDir === "desc" ? -1 : 1
  const byName = (a, b) => compareFileNames(a.name, b.name)
  // Parsed once per entry; a Date in the comparator would re-parse O(n log n) times.
  const mtime = new Map()
  if (state.sortBy === "date") {
    for (const e of state.entries) mtime.set(e, new Date(e.modified).getTime())
  }
  state.entries.sort((a, b) => {
    // The trash is fixed furniture: it outranks grouping, field, and direction.
    if (a.isTrash !== b.isTrash) return a.isTrash ? -1 : 1
    if (state.grouping === "folders" && a.isDir !== b.isDir) return a.isDir ? -1 : 1
    let cmp
    if (state.sortBy === "date") {
      cmp = mtime.get(a) - mtime.get(b)
    } else if (state.sortBy === "size") {
      // Folders carry no size, so they all tie here and settle by name.
      cmp = a.size - b.size
    }
    if (!cmp) cmp = byName(a, b)
    return cmp * dir
  })
}
