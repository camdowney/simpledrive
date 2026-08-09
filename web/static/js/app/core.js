"use strict"

// ─── State ────────────────────────────────────────────────────────────────────

const cachedPrefs = (() => {
  try {
    return JSON.parse(localStorage.getItem("prefs") || "{}")
  } catch {
    return {}
  }
})()

const cachedTags = (() => {
  try {
    return JSON.parse(localStorage.getItem("tags") || "{}")
  } catch {
    return {}
  }
})()

// Per-device, so kept out of prefs and never synced to the server.
const cachedTheme = localStorage.getItem("theme")
const cachedVolume = parseFloat(localStorage.getItem("volume"))

const readAudioMode = (v) => (v === "sequential" || v === "shuffle" ? v : "off")

// { tagId: percent }: each tag keeps its own mix, so a pass resumes at the share it was set to.
const readAudioMixes = (v) => {
  const out = {}
  if (v && typeof v === "object")
    for (const [id, n] of Object.entries(v))
      if (Number.isFinite(n)) out[id] = Math.min(100, Math.max(0, Math.round(n)))
  return out
}

const state = {
  currentPath: "/",
  viewModes: cachedPrefs.viewModes || {}, // { path: 'list' | 'grid' }
  sorts: cachedPrefs.sorts || {}, // { path: { by, dir } }
  viewMode: "list", // active view/sort resolved for the current folder
  sortBy: "name",
  sortDir: "asc",
  groupings: cachedPrefs.groupings || {}, // { path: 'folders' | 'mixed' }
  grouping: "folders", // active grouping resolved for the current folder
  showHidden: cachedPrefs.showHidden === true,
  tags: Array.isArray(cachedTags.tags) ? cachedTags.tags : [], // catalog: { id, name, color }
  fileTags: cachedTags.files || {}, // { path: [tagId] }
  tagFilter: new Set(), // tag ids narrowing the listing; a view, not a setting, so never persisted
  theme: cachedTheme === "light" || cachedTheme === "dark" ? cachedTheme : null, // null = follow OS
  allEntries: [], // full listing before the dotfile filter
  entries: [],
  inMount: false, // current folder lives in a connected bucket
  inVault: false, // current folder is an encrypted vault, or a folder inside one
  vaultRoot: null, // path of that vault's own folder — the only part of it the server knows
  pendingVaultPath: null, // deep link into a locked vault, reopened once it unlocks
  share: null, // { root, name, mode } when this page was opened through a share link
  selected: new Set(),
  lastClickIdx: null, // for shift+click range selection
  editorPath: null,
  editorToken: null, // invalidates stale editor loads when a newer one starts
  editorType: null, // 'text' | 'markdown'
  editorDirty: false,
  editorSavedContent: "", // serialized content as of the last load/save, for dirty compare
  mdeInstance: null,
  viewPushedHistory: false, // whether the current editor/preview view added a history entry
  previewFiles: [], // ordered viewable entries in current dir
  previewIdx: -1, // index of the currently previewed file
  previewEntry: null, // the open file's listing row; an archive has one without joining the queue
  previewType: null, // 'image' | 'video' | 'audio' | 'pdf' | 'archive'
  previewSliding: false, // a swipe's slide animation is mid-flight; ignore new gestures
  audioMode: readAudioMode(cachedPrefs.audioMode), // 'off' | 'sequential' | 'shuffle'
  audioTags: new Set(), // tag ids the play queue is narrowed to; a view, not a setting, so not saved
  audioTagging: null, // tag id the listen/skip verdict writes, or null when not tagging
  audioMixes: readAudioMixes(cachedPrefs.audioMixes), // per tag: % of picks drawn from its untagged
  audioTrack: null, // { path, name } of the playing song that verdict is still owed for
  audioHead: null, // path of the newest song the run has reached; only it is still being judged
  audioTrail: [], // names of the files a run was paged into from; where its back button leaves off
  audioNormalize: cachedPrefs.audioNormalize === true, // level every song to a common loudness
}

// ─── Sharing ──────────────────────────────────────────────────────────────────

const isShareUrl = () => window.location.pathname.startsWith("/s/")

const canEdit = () => !state.share || state.share.mode === "edit"

// A link's own root stands in for "/" everywhere the owner's drive root would be used.
const homePath = () => (state.share ? state.share.root : "/")

// A link on one file: no listing behind it, and no folder above it the visitor may see.
const sharedFile = () => !!state.share && state.share.isDir === false

const sharedFileEntry = () =>
  sharedFile()
    ? {
        name: state.share.name,
        dir: parentPath(state.share.root),
        isDir: false,
        size: state.share.size,
        modified: state.share.modified,
      }
    : null

const withinHome = (p) => {
  const root = homePath()
  return root === "/" || p === root || p.startsWith(root + "/")
}

// ─── API ──────────────────────────────────────────────────────────────────────

// Bumped per mutation and appended to folder thumb URLs to bust the browser image cache.
let thumbEpoch = 0

const api = async (method, path, body, isForm, signal) => {
  const opts = { method, headers: {}, signal }
  if (body && !isForm) {
    opts.headers["Content-Type"] = "application/json"
    opts.body = JSON.stringify(body)
  } else if (body) {
    opts.body = body
  }
  const res = await fetch(path, opts)
  if (res.status === 401) {
    // A visitor has no account to sign into, so a revoked link says so instead.
    if (isShareUrl()) showShareGone()
    else showLogin()
    return null
  }
  if (!res.ok) {
    let msg = res.statusText
    try {
      const d = await res.json()
      msg = d.error || msg
    } catch {}
    throw new Error(msg)
  }
  if (method === "POST" && path.startsWith("/api/files/")) thumbEpoch++
  // The worker answered from its cache, so these rows are the last ones seen, not the current ones.
  if (res.headers.get("x-from-cache")) noteOffline()
  try {
    return await res.json()
  } catch {
    return null
  }
}

let offlineNoted = 0

// Said once per stretch offline: repeating it on every folder would drown out everything else.
const noteOffline = () => {
  if (Date.now() - offlineNoted < 30000) return
  offlineNoted = Date.now()
  toast("Offline — showing what was last loaded")
}

// ─── File type helpers ────────────────────────────────────────────────────────

const EXT_ICON = {
  folder: "📁",
  vault: "🔒",
  trash: "🗑️",
  mount: "🪣",
  image: "🖼️",
  video: "🎬",
  audio: "🎵",
  text: "📄",
  markdown: "📝",
  archive: "📦",
  pdf: "📕",
  code: "💻",
}

const extOf = (name) => name.split(".").pop().toLowerCase()

const IMAGE_EXTS = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg", "avif", "arw"]
const VIDEO_EXTS = ["mp4", "webm", "mkv", "mov", "avi"]
const AUDIO_EXTS = ["mp3", "ogg", "wav", "flac", "aac", "m4a", "opus"]
const ARCHIVE_EXTS = ["zip", "tar", "gz", "bz2", "7z", "rar"]
const CODE_EXTS = "js ts py go rs java c cpp h css html json yaml yml sh toml".split(" ")

// Formats the server can thumbnail; the rest load as the raw file.
const THUMB_EXTS = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "arw"]

// Photo formats the viewer shows screen-sized; PNG/GIF keep originals (alpha, animation).
const DISPLAY_EXTS = ["jpg", "jpeg", "webp", "bmp", "arw"]

// Camera raws: no browser decodes the container, so the server hands back the embedded JPEG.
const RAW_EXTS = ["arw"]
const isRaw = (name) => RAW_EXTS.includes(extOf(name))

const fileType = (name) => {
  const ext = extOf(name)
  if (IMAGE_EXTS.includes(ext)) return "image"
  if (VIDEO_EXTS.includes(ext)) return "video"
  if (AUDIO_EXTS.includes(ext)) return "audio"
  if (["md", "markdown"].includes(ext)) return "markdown"
  if (ext === "pdf") return "pdf"
  if (ARCHIVE_EXTS.includes(ext)) return "archive"
  return "text"
}

// The trash stays a dotfolder on disk; only its label and icon are made friendly.
const TRASH_DIR = ".trash"
const TRASH_LABEL = "Trash"
const displayName = (entry) => (entry.isTrash ? TRASH_LABEL : entry.name)

const fileIcon = (entry) => {
  if (entry.isTrash) return EXT_ICON.trash
  if (entry.isMount) return EXT_ICON.mount
  if (entry.isVault) return EXT_ICON.vault
  if (entry.isDir) return EXT_ICON.folder
  const type = fileType(entry.name)
  if (type !== "text") return EXT_ICON[type]
  if (CODE_EXTS.includes(extOf(entry.name))) return EXT_ICON.code
  return EXT_ICON.text
}

// No mobile browser embeds a PDF: iOS paints only page one, Android blanks or downloads.
const EMBEDS_PDF = (() => {
  const ua = navigator.userAgent
  // iPadOS 13+ claims to be a Mac; touch points tell them apart.
  const iPadDesktopMode = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  if (iPadDesktopMode || /Mobi|Tablet|Android|iPad|iPhone|iPod/.test(ua)) return false
  // iOS lies here (says true, still fails), but on desktop it catches a disabled viewer.
  return navigator.pdfViewerEnabled !== false
})()

const isMedia = (name) => {
  const t = fileType(name)
  return t === "image" || t === "video" || t === "audio"
}

const isViewable = (name) => {
  const t = fileType(name)
  return t === "image" || t === "video" || t === "audio" || (t === "pdf" && EMBEDS_PDF)
}

const MAX_EDITABLE_SIZE = 10 << 20 // mirrors the server's cap on what it hands the text editor

const tooBigToEdit = (name) => {
  if (!["text", "markdown"].includes(fileType(name))) return false
  const entry = state.entries.find((e) => e.name === name) || sharedFileEntry()
  return !!entry && entry.name === name && entry.size > MAX_EDITABLE_SIZE
}

const previewsBlank = (name) => fileType(name) === "archive" || tooBigToEdit(name)

const fmtSize = (bytes) => {
  if (bytes < 1024) return bytes + " B"
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB"
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB"
  return (bytes / 1024 / 1024 / 1024).toFixed(1) + " GB"
}

const fmtDuration = (secs) => {
  const h = Math.floor(secs / 3600)
  const m = String(Math.floor((secs % 3600) / 60)).padStart(2, "0")
  const s = String(secs % 60).padStart(2, "0")
  return h ? `${String(h).padStart(2, "0")}:${m}:${s}` : `${m}:${s}`
}

const fmtDate = (iso) => {
  const d = new Date(iso)
  // S3 prefixes carry no timestamp; the zero date would otherwise render as "Jan 1, 1".
  if (isNaN(d.getTime()) || d.getFullYear() < 1970) return "—"
  const date = d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" })
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  return `${date} <span class="file-meta-time">${time}</span>`
}

// The value format a <input type="datetime-local" step="1"> expects.
const toEditableDate = (iso) => {
  const d = new Date(iso)
  const p = (n) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(
    d.getMinutes()
  )}:${p(d.getSeconds())}`
}

const parseEditableDate = (s) => {
  const d = new Date(s.trim().replace(" ", "T")) // read back as local time
  return isNaN(d.getTime()) ? null : d
}

const joinPath = (dir, name) => (dir.replace(/\/$/, "") + "/" + name).replace(/^\/\//, "/")

const relPath = (name) => joinPath(state.currentPath, name)

const parentPath = (path) => path.slice(0, path.lastIndexOf("/")) || "/"

// An entry sits in the open folder unless it carries its own dir — the breadcrumb's does.
const entryDir = (entry) => entry.dir || state.currentPath
const entryPath = (entry) => joinPath(entryDir(entry), entry.name)

// The vault's own folder is browsed from inside the vault but is an ordinary server directory.
const inVaultIndex = (entry) => state.inVault && Vault.covers(entryDir(entry))

const inTrashPath = (path) => path.startsWith(`/${TRASH_DIR}/`)
const atOrInTrash = (path) => path === `/${TRASH_DIR}` || inTrashPath(path)

// Targets that own Space and Enter themselves; shortcuts on those keys must let them through.
const typingOrPressing = (el) =>
  el instanceof HTMLInputElement ||
  el instanceof HTMLTextAreaElement ||
  el instanceof HTMLSelectElement ||
  el instanceof HTMLButtonElement ||
  el instanceof HTMLMediaElement ||
  el.isContentEditable

// A viewer button keeps focus after a click, and Space there means the player, not another press.
const spaceIsPlayers = (el) =>
  !typingOrPressing(el) || (el instanceof HTMLButtonElement && !!el.closest("#preview-view"))

// An opener stops the click from reaching other menus' close handlers, so shut them here.
const closePopovers = (except) => {
  for (const p of document.querySelectorAll(".popover.open")) {
    if (p === except) continue
    p.classList.remove("open")
    document.querySelector(`[aria-controls="${p.id}"]`)?.setAttribute("aria-expanded", "false")
  }
}

// ─── Toast ────────────────────────────────────────────────────────────────────

let toastTimer
const toast = (msg, isError = false, onUndo = null) => {
  const el = document.getElementById("toast")
  const text = document.createElement("span")
  text.className = "toast-msg"
  text.textContent = msg
  el.replaceChildren(text)
  if (onUndo) {
    const btn = document.createElement("button")
    btn.type = "button"
    btn.className = "toast-action"
    btn.textContent = "Undo"
    btn.addEventListener("click", () => {
      el.classList.remove("show")
      clearTimeout(toastTimer)
      onUndo()
    })
    el.appendChild(btn)
  }
  // Only an action needs reaching, so only it gets lifted off the viewer's bar.
  const lift = onUndo && document.getElementById("preview-tagbar").offsetHeight > 0
  el.className =
    "toast show" +
    (isError ? " error" : "") +
    (onUndo ? " has-action" : "") +
    (lift ? " lifted" : "")
  const hold = onUndo ? 6000 : 3000 // an undo has to stay up long enough to be noticed and reached
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    el.classList.remove("show")
  }, hold)
}
