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

// ─── Modal ────────────────────────────────────────────────────────────────────

const showModal = ({ title, placeholder, defaultValue = "", extra = "", okLabel = "OK", onOk }) => {
  document.getElementById("modal-title").textContent = title
  const inp = document.getElementById("modal-input")
  inp.placeholder = placeholder || ""
  inp.value = defaultValue
  document.getElementById("modal-extra").innerHTML = extra
  document.getElementById("modal-ok").textContent = okLabel
  document.getElementById("modal-ok").disabled = false
  document.getElementById("modal-backdrop").classList.add("active")
  inp.focus()
  inp.select()

  const cleanup = () => {
    document.getElementById("modal-backdrop").classList.remove("active")
    document.getElementById("modal-backdrop").onclick = null
    document.getElementById("modal-ok").onclick = null
    document.getElementById("modal-cancel").onclick = null
    inp.onkeydown = null
  }

  const submit = () => {
    cleanup()
    onOk(inp.value.trim())
  }

  document.getElementById("modal-ok").onclick = submit
  document.getElementById("modal-cancel").onclick = cleanup
  document.getElementById("modal-backdrop").onclick = (e) => {
    if (e.target === document.getElementById("modal-backdrop")) cleanup()
  }
  inp.onkeydown = (e) => {
    if (e.key === "Enter") submit()
    if (e.key === "Escape") cleanup()
  }
}

// Shared shell for modals built in #modal-extra; onOk closes it via the returned cleanup.
const showExtraModal = ({
  title,
  extraHtml,
  okLabel,
  danger = false,
  closeOnly = false,
  wide = false,
  okClass = "",
  dismissible = true,
  onOk,
}) => {
  const backdrop = document.getElementById("modal-backdrop")
  const okBtn = document.getElementById("modal-ok")
  const cancelBtn = document.getElementById("modal-cancel")
  const inp = document.getElementById("modal-input")
  const extra = document.getElementById("modal-extra")

  document.getElementById("modal-title").textContent = title
  inp.style.display = "none"
  extra.innerHTML = extraHtml
  okBtn.textContent = okLabel
  // The button is shared, so a dialog that closed while disabled would kill every later confirm.
  okBtn.disabled = false
  okBtn.className =
    okClass || (danger ? "btn btn-danger" : closeOnly ? "btn btn-ghost" : "btn btn-primary")
  if (closeOnly) cancelBtn.style.display = "none"
  document.getElementById("modal").classList.toggle("modal-wide", wide)
  backdrop.classList.add("active")

  const cleanup = () => {
    backdrop.classList.remove("active")
    inp.style.display = ""
    extra.innerHTML = ""
    extra.onkeydown = null
    okBtn.className = "btn btn-primary"
    cancelBtn.style.display = ""
    document.getElementById("modal").classList.remove("modal-wide")
    okBtn.onclick = null
    cancelBtn.onclick = null
    backdrop.onclick = null
  }

  okBtn.onclick = onOk
  cancelBtn.onclick = cleanup
  // Esc routes through backdrop.onclick, so leaving it unset is what makes a modal unskippable.
  if (dismissible)
    backdrop.onclick = (e) => {
      if (e.target === backdrop) cleanup()
    }
  extra.onkeydown = (e) => {
    if (e.key === "Enter") onOk()
    if (e.key === "Escape" && dismissible) cleanup()
  }
  return cleanup
}

const showConfirm = ({ title, message, okLabel = "Delete", onOk }) => {
  const cleanup = showExtraModal({
    title,
    extraHtml: `<p class="confirm-message">${esc(message)}</p>`,
    okLabel,
    danger: true,
    onOk: () => {
      cleanup()
      onOk()
    },
  })
  document.getElementById("modal-cancel").focus()
}

const withOrigExt = (origName, newName) => {
  const origExt = origName.includes(".") ? origName.slice(origName.lastIndexOf(".")) : ""
  return origExt && !newName.includes(".") ? newName + origExt : newName
}

// Renaming the open folder moves the listing out from under us, so follow it to its new path.
const followRename = async (entry, newName) => {
  const dir = entryDir(entry)
  if (joinPath(dir, entry.name) !== state.currentPath) {
    await navigate(state.currentPath, { pushHash: false })
    return
  }
  await navigate(joinPath(dir, newName), { pushHash: false })
  replacePathHash(state.currentPath)
}

const showRename = (entry, { onRenamed } = {}) => {
  const inp = document.getElementById("modal-input")
  showModal({
    title: "Rename",
    defaultValue: entry.name,
    okLabel: "Rename",
    onOk: async (raw) => {
      if (!raw || raw === entry.name) return
      const newName = withOrigExt(entry.name, raw)
      if (newName === entry.name) return
      const dir = entryDir(entry)
      try {
        if (inVaultIndex(entry)) {
          await Vault.rename(vaultSubOf(dir), entry.name, newName)
          await followRename(entry, newName)
        } else {
          await api("POST", "/api/files/rename", { dir, from: entry.name, to: newName })
          retagPath(joinPath(dir, entry.name), joinPath(dir, newName))
          await followRename(entry, newName)
        }
        onRenamed?.(newName)
      } catch (e) {
        toast(e.message, true)
      }
    },
  })
  const dot = entry.name.lastIndexOf(".")
  const caret = dot > 0 ? dot : entry.name.length
  inp.setSelectionRange(caret, caret)
}

const deleteEntries = (entries, { after } = {}) => {
  if (!entries.length) return
  const label = entries.length === 1 ? `“${entries[0].name}”` : `${entries.length} items`
  // Removing a bucket's folder only drops the stored credentials; the bucket keeps its objects.
  const onlyMount = entries.length === 1 && entries[0].isMount
  // Already in the trash, so the server erases outright rather than trashing again.
  const purging = entries.some((e) => inTrashPath(entryPath(e)))
  // Only local files land in the trash; bucket objects and vault entries are erased outright.
  const recoverable =
    !state.inMount && !inVaultIndex(entries[0]) && !purging && !entries.some((e) => e.isMount)
  showConfirm({
    title: onlyMount
      ? `Disconnect ${label}?`
      : purging
        ? `Permanently delete ${label}?`
        : `Delete ${label}?`,
    message: onlyMount
      ? "The bucket and its contents are left untouched. You'll need the credentials again to reconnect."
      : recoverable
        ? "Files can be restored from the trash can."
        : "This action cannot be undone.",
    okLabel: onlyMount ? "Disconnect" : purging ? "Delete forever" : "Delete",
    onOk: async () => {
      if (inVaultIndex(entries[0])) {
        try {
          for (const entry of entries) releaseVaultBlob(entry.id)
          // Off the entry's own dir: the crumb menu acts on the open folder, which sits above it.
          await Vault.remove(
            vaultSubOf(entryDir(entries[0])),
            entries.map((e) => e.name)
          )
        } catch (e) {
          toast(e.message, true)
        }
        state.selected.clear()
        if (after) after()
        else navigate(state.currentPath)
        return
      }
      const trashed = []
      for (const entry of entries) {
        const rel = entryPath(entry)
        try {
          const res = await api("POST", "/api/files/delete", { path: rel })
          const tags = retagPath(rel, null)
          if (res.trashed) trashed.push({ name: entry.name, tags })
        } catch (e) {
          toast(`Failed to delete “${entry.name}”: ${e.message}`, true)
        }
      }
      state.selected.clear()
      if (after) after()
      else navigate(state.currentPath)
      if (trashed.length) offerUndoDelete(trashed)
    },
  })
}

// The trash names entries by basename; a collision costs only this shortcut, not the file.
const offerUndoDelete = (items) => {
  // Not "Moved … to trash": a long name ellipsises the tail away, leaving a half-sentence.
  const label = items.length === 1 ? `Deleted “${items[0].name}”` : `Deleted ${items.length} items`
  toast(label, false, async () => {
    for (const { name, tags } of items) {
      try {
        const res = await api("POST", "/api/trash/restore", { name })
        // Restore lands beside a name reused since the delete, so the tags follow the reported path.
        if (res && res.path) retagUnder(res.path, tags)
      } catch (e) {
        toast(e.message, true)
        return
      }
    }
    await navigate(state.currentPath, { pushHash: false })
    showBrowser()
  })
}

const shareUrl = (token) => `${window.location.origin}/s/${token}`

// The clipboard API needs HTTPS or localhost; execCommand is the only route on a bare-IP host.
const copyText = async (text) => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {}
  const was = document.activeElement
  const ta = document.createElement("textarea")
  ta.value = text
  ta.readOnly = true
  ta.style.cssText = "position:fixed;top:0;opacity:0"
  document.body.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand("copy")
  } catch {}
  ta.remove()
  was?.focus?.()
  return ok
}

const SHARE_LABEL_MAX = 60

const SHARE_MODE_LABEL = { edit: "View &amp; edit", drop: "Drop box", view: "View only" }

const shareLinkHtml = (sh) => `
  <div class="share-link" data-id="${esc(sh.id)}" data-url="${esc(shareUrl(sh.token))}">
    <span class="share-link-mode">${SHARE_MODE_LABEL[sh.mode] || SHARE_MODE_LABEL.view}</span>
    <input class="share-link-label js-share-label" placeholder="Add a label"
      maxlength="${SHARE_LABEL_MAX}" value="${esc(sh.label || "")}" aria-label="Link label" />
    <button type="button" class="share-link-btn js-share-copy" title="Copy link" aria-label="Copy link">
      <svg class="btn-icon" aria-hidden="true"><use href="#icon-copy" /></svg>
    </button>
    <button type="button" class="share-link-btn js-share-revoke" title="Revoke link" aria-label="Revoke link">
      <svg class="btn-icon" aria-hidden="true"><use href="#icon-unlink" /></svg>
    </button>
    <div class="share-link-confirm">
      <span>Revoke this link?</span>
      <button type="button" class="btn btn-ghost js-share-revoke-cancel">Cancel</button>
      <button type="button" class="btn btn-danger js-share-revoke-ok">Revoke</button>
    </div>
  </div>`

const shareSectionHtml = (rel, name, shares, isDir) => {
  const mine = shares.filter((sh) => "/" + sh.path === rel)
  // A drop box collects into a folder, so a shared file has nowhere for one to put anything.
  const drop = isDir ? `<option value="drop">Drop box</option>` : ""
  return `
  <div class="share-dialog">
    <p class="dialog-subject">${esc(name)}</p>
    <div class="share-new">
      <input id="share-new-label" class="share-new-label" placeholder="Label (optional)"
        maxlength="${SHARE_LABEL_MAX}" aria-label="Label for the new link" />
      <select class="share-new-mode" id="share-new-mode">
        <option value="view">View only</option>
        <option value="edit">View &amp; edit</option>
        ${drop}
      </select>
      <button type="button" class="btn btn-secondary share-new-create" id="share-new-create">Create</button>
    </div>
    <p class="share-mode-note" id="share-mode-note"></p>
    <div id="share-links">${mine.map(shareLinkHtml).join("")}</div>
  </div>`
}

const SHARE_MODE_NOTE = {
  view: "Can view and download anything inside.",
  edit: "Can view, download, add, rename, and delete anything inside.",
  drop: "Can only upload files.",
}

const wireShareSection = (rel) => {
  const list = document.getElementById("share-links")
  const labelInp = document.getElementById("share-new-label")
  const modeSel = document.getElementById("share-new-mode")
  const modeNote = document.getElementById("share-mode-note")

  const showModeNote = () => {
    modeNote.textContent = SHARE_MODE_NOTE[modeSel.value] || ""
  }
  modeSel.addEventListener("change", showModeNote)
  showModeNote()

  const copyShareUrl = async (row) => {
    if (await copyText(row.dataset.url)) toast("Link copied")
    else toast("Couldn't copy link", true)
  }

  const createBtn = document.getElementById("share-new-create")

  // Enter here belongs to the share section; the modal's own Enter handler would close the dialog.
  list.closest(".share-dialog").onkeydown = (e) => {
    if (e.key !== "Enter") return
    e.stopPropagation()
    if (e.target === labelInp) createBtn.click()
    else if (e.target.closest(".js-share-label")) e.target.blur()
  }

  createBtn.onclick = async () => {
    const mode = document.getElementById("share-new-mode").value
    try {
      const sh = await api("POST", "/api/shares", { path: rel, mode, label: labelInp.value })
      list.insertAdjacentHTML("beforeend", shareLinkHtml(sh))
      labelInp.value = ""
      await copyShareUrl(list.querySelector(`.share-link[data-id="${sh.id}"]`))
    } catch (e) {
      toast(e.message, true)
    }
  }

  // change fires on blur only when the text actually differs, so this saves once per real edit.
  list.onchange = async (e) => {
    const inp = e.target.closest(".js-share-label")
    if (!inp) return
    const row = inp.closest(".share-link")
    try {
      const sh = await api("PATCH", "/api/shares", { id: row.dataset.id, label: inp.value })
      inp.value = sh.label
      toast("Label saved")
    } catch (err) {
      toast(err.message, true)
    }
  }

  list.onclick = async (e) => {
    const row = e.target.closest(".share-link")
    if (!row) return
    if (e.target.closest(".js-share-copy")) {
      await copyShareUrl(row)
      return
    }
    // This dialog owns the only modal, so revoking confirms in the row instead.
    if (e.target.closest(".js-share-revoke")) {
      row.classList.add("confirming")
      row.querySelector(".js-share-revoke-cancel").focus()
      return
    }
    if (e.target.closest(".js-share-revoke-cancel")) {
      row.classList.remove("confirming")
      return
    }
    if (e.target.closest(".js-share-revoke-ok")) {
      try {
        await api("DELETE", `/api/shares?id=${encodeURIComponent(row.dataset.id)}`)
        row.remove()
        toast("Link revoked")
      } catch (err) {
        row.classList.remove("confirming")
        toast(err.message, true)
      }
    }
  }
}

const showTagsDialog = (entry) => {
  const rel = entryPath(entry)
  const cleanup = showExtraModal({
    title: "Tags",
    extraHtml: `
    <div class="tag-dialog">
      <p class="dialog-subject">${esc(entry.name)}</p>
      ${tagEditorHtml(rel)}
    </div>`,
    okLabel: "Done",
    closeOnly: true,
    okClass: "btn btn-subtle",
    onOk: () => cleanup(),
  })
  // Tags save as they are set, not on the dialog's button.
  wireTagEditor(document.querySelector(".tag-dialog .tag-editor"), renderFiles)
}

// Links are the owner's to hand out, so this is never reachable through one.
const showShareDialog = async (entry) => {
  const rel = entryPath(entry)
  let shares = []
  try {
    shares = (await api("GET", "/api/shares"))?.shares || []
  } catch {}
  const cleanup = showExtraModal({
    title: "Share links",
    extraHtml: shareSectionHtml(rel, entry.name, shares, !!entry.isDir),
    okLabel: "Done",
    closeOnly: true,
    okClass: "btn btn-subtle",
    onOk: () => cleanup(),
  })
  wireShareSection(rel)
}

// Metadata is fetched before the modal opens so every row renders together, with no pop-in.
const showDetails = async (entry, { onRenamed } = {}) => {
  const detailRow = (k, v) =>
    `<div class="detail-row"><span class="detail-label">${k}</span><span class="detail-value">${esc(v)}</span></div>`
  const dateRow = (k, iso) =>
    `<div class="detail-row"><span class="detail-label">${k}</span><span class="detail-value">${fmtDate(iso)}</span></div>`

  const rel = entryPath(entry)
  // A file link can't rename its target: the new name falls outside what the link covers.
  const readOnly = !canEdit() || sharedFile()
  let meta = null
  // The server can't read a vault's files, so everything shown of one comes from its index.
  if (!inVaultIndex(entry)) {
    try {
      meta = await api("GET", `/api/files/meta?path=${encodeURIComponent(rel)}`)
    } catch {}
  }

  const rows = []
  if (!entry.isDir) rows.push(detailRow("Size", fmtSize(entry.size)))
  // A folder's size is a full walk, so it lands in the open dialog when ready.
  const measurable = entry.isDir && !entry.isVault && !inVaultIndex(entry)
  if (measurable)
    rows.push(
      `<div class="detail-row">
        <span class="detail-label">Contents</span>
        <span class="detail-value" id="detail-contents">Measuring…</span>
      </div>`
    )
  if (meta?.width && meta?.height)
    rows.push(detailRow("Dimensions", `${meta.width} × ${meta.height}`))
  // "Date taken" comes from JPEG EXIF or the MOV/MP4 header; others fall back to created/modified.
  const kind = fileType(entry.name)
  if ((kind === "image" || kind === "video") && !entry.isDir) {
    rows.push(dateRow("Taken", meta?.dateTaken || meta?.created || entry.modified))
  } else {
    rows.push(dateRow("Created", meta?.created || entry.modified))
  }
  // Buckets don't store a settable mtime, so the date stays read-only inside one.
  const dateLocked = state.inMount || entry.isMount || readOnly || inVaultIndex(entry)
  const lockTitle = readOnly
    ? "This link is view-only"
    : inVaultIndex(entry)
      ? "A vault keeps its own dates"
      : "Dates can't be changed in a connected bucket"
  rows.push(
    `<div class="detail-row">
      <span class="detail-label">Modified</span>
      <button type="button" class="detail-edit-toggle" id="detail-modified-toggle" aria-label="Edit date"
        ${dateLocked ? `disabled title="${lockTitle}"` : ""}>
        <svg class="btn-icon" aria-hidden="true"><use href="#icon-pencil" /></svg>
      </button>
      <span class="detail-value" id="detail-modified-display">${fmtDate(entry.modified)}</span>
      <input type="datetime-local" step="1" id="detail-modified" class="detail-date-input hidden" value="${esc(
        toEditableDate(entry.modified)
      )}" />
    </div>`
  )

  const cleanup = showExtraModal({
    title: "Details",
    extraHtml: `
    <div class="detail-rows">
      <div class="detail-row">
        <span class="detail-label">Name</span>
        ${
          readOnly
            ? `<span class="detail-value">${esc(entry.name)}</span>`
            : `<input id="detail-name" value="${esc(entry.name)}" />`
        }
      </div>
      ${rows.join("")}
    </div>`,
    okLabel: readOnly ? "Close" : "Save",
    closeOnly: readOnly,
    okClass: readOnly ? "btn btn-subtle" : "",
    onOk: () => (readOnly ? cleanup() : submit()),
  })
  const nameInp = document.getElementById("detail-name")

  if (measurable) {
    api("GET", `/api/files/size?path=${encodeURIComponent(rel)}`)
      .then((d) => {
        const el = document.getElementById("detail-contents")
        if (!el || !d) return
        const files = `${d.files} file${d.files === 1 ? "" : "s"}`
        el.textContent = `${fmtSize(d.bytes)} · ${files}${d.partial ? " so far" : ""}`
      })
      .catch(() => {
        const el = document.getElementById("detail-contents")
        if (el) el.textContent = "—"
      })
  }

  document.getElementById("detail-modified-toggle").onclick = () => {
    const disp = document.getElementById("detail-modified-display")
    const mi = document.getElementById("detail-modified")
    const startEditing = mi.classList.contains("hidden")
    mi.classList.toggle("hidden", !startEditing)
    disp.classList.toggle("hidden", startEditing)
    if (startEditing) mi.focus()
  }

  const submit = async () => {
    if (!nameInp.value.trim()) return
    const newName = withOrigExt(entry.name, nameInp.value.trim())

    const modInput = document.getElementById("detail-modified").value
    const modDate = parseEditableDate(modInput)
    if (!modDate) {
      toast("Please choose a valid date", true)
      return
    }
    const nameChanged = newName !== entry.name
    const modChanged = modInput.trim() !== toEditableDate(entry.modified)
    if (!nameChanged && !modChanged) {
      cleanup()
      return
    }
    cleanup()
    const dir = entryDir(entry)
    if (inVaultIndex(entry)) {
      try {
        await Vault.rename(vaultSubOf(dir), entry.name, newName)
        await followRename(entry, newName)
        onRenamed?.(newName)
      } catch (e) {
        toast(e.message, true)
      }
      return
    }
    try {
      const payload = { dir, from: entry.name, to: newName }
      if (modChanged) payload.modified = modDate.toISOString()
      await api("POST", "/api/files/rename", payload)
      if (nameChanged) retagPath(rel, joinPath(dir, newName))
      await followRename(entry, newName)
      if (nameChanged) onRenamed?.(newName)
    } catch (e) {
      toast(e.message, true)
    }
  }
}

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

const showStorage = () => {
  const cleanup = showExtraModal({
    title: "Storage",
    okLabel: "Close",
    closeOnly: true,
    okClass: "btn btn-subtle",
    extraHtml: `
    <div class="storage">
      <div class="storage-meter" id="storage-meter">
        <div class="storage-bar"></div>
        <p class="storage-line">Reading the disk…</p>
      </div>
      <p class="storage-heading">By type</p>
      <div class="storage-bar storage-types" id="storage-types"></div>
      <div id="storage-legend">
        ${STORAGE_TYPES.map((t) => typeRowHtml(t, null, 0)).join("")}
      </div>
      <p class="storage-summary" id="storage-note"></p>
    </div>`,
    onOk: () => cleanup(),
  })

  const meterEl = document.getElementById("storage-meter")
  const typesEl = document.getElementById("storage-types")
  const legendEl = document.getElementById("storage-legend")
  const noteEl = document.getElementById("storage-note")

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
        <p class="storage-line"><strong>${fmtSize(u.free)}</strong> free of ${fmtSize(u.total)}</p>`
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

// A null state.theme follows the OS; boot.js applies the same resolution before first paint.
const applyTheme = () => {
  const theme = state.theme || (systemTheme.matches ? "dark" : "light")
  document.documentElement.dataset.theme = theme
  document.getElementById("theme-color").content = theme === "dark" ? "#16171a" : "#f5f5f5"
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

// ─── Tags ─────────────────────────────────────────────────────────────────────

// A new tag claims the first unused color, so a small set of tags never repeats one.
const TAG_COLORS = [
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
]
const TAG_NAME_MAX = 32

const tagById = (id) => state.tags.find((t) => t.id === id)

// Sorting the catalog itself, not each render: chips, menus and rows all follow its order.
const sortTags = () => {
  state.tags.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
}

// Catalogs saved before this ordering existed are still in creation order.
sortTags()

// Catalog order, so one file's chips read the same everywhere; ids of deleted tags drop out.
const tagsFor = (path) => {
  const ids = state.fileTags[path]
  return ids && ids.length ? state.tags.filter((t) => ids.includes(t.id)) : []
}

const tagUseCount = (id) => Object.values(state.fileTags).filter((ids) => ids.includes(id)).length

const tagsBlob = () => ({ tags: state.tags, files: state.fileTags })

let tagsSyncTimer = null
const saveTags = () => {
  const blob = tagsBlob()
  localStorage.setItem("tags", JSON.stringify(blob))
  // A share visitor has no owner session; the PUT would 401 and tear down the page.
  if (state.share) return
  clearTimeout(tagsSyncTimer)
  tagsSyncTimer = setTimeout(() => api("PUT", "/api/tags", blob).catch(() => {}), 400)
}

const syncTagsFromServer = async () => {
  const blob = await api("GET", "/api/tags").catch(() => null)
  if (!blob || typeof blob !== "object") return
  state.tags = Array.isArray(blob.tags) ? blob.tags : []
  sortTags()
  state.fileTags = blob.files || {}
  for (const id of state.tagFilter) if (!tagById(id)) state.tagFilter.delete(id)
  for (const id of state.audioTags) if (!tagById(id)) state.audioTags.delete(id)
  if (state.audioTagging && !tagById(state.audioTagging)) state.audioTagging = null
  localStorage.setItem("tags", JSON.stringify(tagsBlob()))
  if (document.getElementById("browser-view").classList.contains("hidden")) return
  if (!state.allEntries.length) return
  applyEntryFilters()
  sortEntries()
  updateTagToggle()
  renderFiles()
}

const createTag = (name) => {
  const clean = name.trim().slice(0, TAG_NAME_MAX)
  if (!clean) return null
  const existing = state.tags.find((t) => t.name.toLowerCase() === clean.toLowerCase())
  if (existing) return existing
  const used = new Set(state.tags.map((t) => t.color))
  const tag = {
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    name: clean,
    color:
      TAG_COLORS.find((c) => !used.has(c)) || TAG_COLORS[state.tags.length % TAG_COLORS.length],
  }
  state.tags.push(tag)
  sortTags()
  saveTags()
  return tag
}

const deleteTag = (id) => {
  state.tags = state.tags.filter((t) => t.id !== id)
  for (const [path, ids] of Object.entries(state.fileTags)) {
    const kept = ids.filter((i) => i !== id)
    if (kept.length) state.fileTags[path] = kept
    else delete state.fileTags[path]
  }
  state.tagFilter.delete(id)
  state.audioTags.delete(id)
  if (state.audioTagging === id) state.audioTagging = null
  if (id in state.audioMixes) {
    delete state.audioMixes[id]
    savePrefs()
  }
  saveTags()
}

// Assignments name tags by id, so a rename needs no rewrite; false when blank or taken.
const renameTag = (id, name) => {
  const tag = tagById(id)
  const clean = name.trim().slice(0, TAG_NAME_MAX)
  if (!tag || !clean) return false
  const taken = state.tags.some((t) => t.id !== id && t.name.toLowerCase() === clean.toLowerCase())
  if (taken) return false
  tag.name = clean
  sortTags()
  saveTags()
  return true
}

const cycleTagColor = (id) => {
  const tag = tagById(id)
  if (!tag) return
  tag.color = TAG_COLORS[(TAG_COLORS.indexOf(tag.color) + 1) % TAG_COLORS.length]
  saveTags()
}

const setFileTag = (path, id, on) => {
  const ids = state.fileTags[path] || []
  const next = on ? (ids.includes(id) ? ids : [...ids, id]) : ids.filter((i) => i !== id)
  if (next.length) state.fileTags[path] = next
  else delete state.fileTags[path]
  saveTags()
}

// A null `to` drops the tags; the return keys them by suffix so undo can re-hang them.
const retagPath = (from, to) => {
  const taken = {}
  for (const path of Object.keys(state.fileTags)) {
    if (path !== from && !path.startsWith(from + "/")) continue
    const ids = state.fileTags[path]
    delete state.fileTags[path]
    taken[path.slice(from.length)] = ids
    if (to) state.fileTags[to + path.slice(from.length)] = ids
  }
  saveTags()
  return taken
}

const retagUnder = (base, taken) => {
  for (const [suffix, ids] of Object.entries(taken)) state.fileTags[base + suffix] = ids
  saveTags()
}

const tagOpenerHtml = (path) => {
  const dots = tagsFor(path)
    .slice(0, 3)
    .map((t) => `<span class="tag-dot" style="--tag-color: ${esc(t.color)}"></span>`)
    .join("")
  // Grouped, so the button's gap falls between the dots and the label rather than within them.
  return `${dots ? `<span class="tag-dots">${dots}</span>` : ""}<span>Tags</span>`
}

const tagEditorHtml = (path, compact) => `
  <div class="tag-editor${compact ? " tag-editor-compact" : " tag-editor-inline"}"
    data-path="${esc(path)}">
    ${
      compact
        ? `<button type="button" class="tag-add js-tag-open">${tagOpenerHtml(path)}</button>`
        : ""
    }
    <div class="tag-menu">
      <input class="tag-menu-input" placeholder="Find or create a tag" maxlength="${TAG_NAME_MAX}"
        autocomplete="off" spellcheck="false" aria-label="Find or create a tag" />
      <div class="tag-menu-list"></div>
    </div>
  </div>`

const wireTagEditor = (root, onChange) => {
  const path = root.dataset.path
  const input = root.querySelector(".tag-menu-input")
  const list = root.querySelector(".tag-menu-list")
  const addBtn = root.querySelector(".js-tag-open")

  const compact = root.classList.contains("tag-editor-compact")

  const renderMenu = () => {
    const query = input.value.trim()
    const q = query.toLowerCase()
    const ids = state.fileTags[path] || []
    const shown = state.tags.filter((t) => t.name.toLowerCase().includes(q))
    const rows = shown
      .map(
        (t) => `
      <button type="button" class="tag-menu-item${ids.includes(t.id) ? " active" : ""}"
        role="menuitemcheckbox" aria-checked="${ids.includes(t.id)}" data-id="${esc(t.id)}">
        <span class="tag-dot" style="--tag-color: ${esc(t.color)}"></span>
        <span class="tag-menu-name">${esc(t.name)}</span>
        <svg class="tag-menu-check" aria-hidden="true"><use href="#icon-check" /></svg>
      </button>`
      )
      .join("")
    const canCreate = q && !state.tags.some((t) => t.name.toLowerCase() === q)
    const create = canCreate
      ? `<button type="button" class="tag-menu-item js-tag-create">
          <svg class="tag-menu-plus" aria-hidden="true"><use href="#icon-plus" /></svg>
          <span class="tag-menu-name">Create “${esc(query)}”</span>
        </button>`
      : ""
    const empty = !rows && !create ? `<p class="tag-menu-empty">No tags created yet.</p>` : ""
    list.innerHTML = rows + create + empty
  }

  const setOpen = (open) => {
    root.classList.toggle("menu-open", open)
    addBtn.setAttribute("aria-expanded", String(open))
    if (!open) {
      input.value = ""
      return
    }
    renderMenu()
  }

  const commit = (id, on) => {
    setFileTag(path, id, on)
    // Hand-setting the tag being autotagged settles the open song: no verdict may overrule it.
    if (id === state.audioTagging && state.audioTrack?.path === path) state.audioTrack.manual = true
    if (compact) addBtn.innerHTML = tagOpenerHtml(path)
    renderMenu()
    onChange?.()
  }

  // The inline form is always open, so it fills its list once and never toggles.
  if (compact) addBtn.setAttribute("aria-expanded", "false")
  else renderMenu()

  root.addEventListener("click", (e) => {
    if (e.target.closest(".js-tag-open")) {
      setOpen(!root.classList.contains("menu-open"))
      return
    }
    if (e.target.closest(".js-tag-create")) {
      const tag = createTag(input.value)
      if (tag) {
        input.value = ""
        commit(tag.id, true)
      }
      input.focus()
      return
    }
    const item = e.target.closest(".tag-menu-item")
    if (item) commit(item.dataset.id, !item.classList.contains("active"))
  })

  input.addEventListener("input", renderMenu)

  // Enter and Escape belong to the editor; a modal's own handlers would save and close it.
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && root.classList.contains("menu-open")) {
      e.stopPropagation()
      setOpen(false)
      return
    }
    if (e.key !== "Enter") return
    e.stopPropagation()
    // Anywhere but the field, Enter is a button press the browser still has to deliver.
    if (e.target !== input) return
    e.preventDefault()
    const query = input.value.trim()
    if (!query) return
    const first = list.querySelector(".tag-menu-item[data-id]")
    const tag = first ? tagById(first.dataset.id) : createTag(query)
    if (!tag) return
    input.value = ""
    commit(tag.id, true)
  })

  // Self-removing: the modal and the viewer both drop the editor by clearing their innerHTML.
  const onDocClick = (e) => {
    if (!root.isConnected) document.removeEventListener("click", onDocClick, true)
    else if (!root.contains(e.target)) setOpen(false)
  }
  if (compact) document.addEventListener("click", onDocClick, true)
}

const tagRowHtml = (tag) => {
  const on = state.tagFilter.has(tag.id)
  return `
  <div class="tag-row" data-id="${esc(tag.id)}">
    <button type="button" class="tag-row-color js-tag-color" style="--tag-color: ${esc(tag.color)}"
      title="Change color" aria-label="Change the color of ${esc(tag.name)}"></button>
    <button type="button" class="tag-row-main js-tag-filter${on ? " active" : ""}"
      role="menuitemcheckbox" aria-checked="${on}">
      <span class="tag-row-name">${esc(tag.name)}</span>
      <svg class="tag-row-check" aria-hidden="true"><use href="#icon-check" /></svg>
      <span class="tag-row-count">${tagUseCount(tag.id)}</span>
    </button>
    <button type="button" class="tag-row-btn js-tag-rename" title="Rename tag"
      aria-label="Rename tag ${esc(tag.name)}">
      <svg aria-hidden="true"><use href="#icon-pencil" /></svg>
    </button>
    <button type="button" class="tag-row-btn tag-row-btn-danger js-tag-delete" title="Delete tag"
      aria-label="Delete tag ${esc(tag.name)}">
      <svg aria-hidden="true"><use href="#icon-trash" /></svg>
    </button>
    <div class="tag-row-confirm">
      <span>Delete this tag?</span>
      <button type="button" class="btn btn-ghost js-tag-delete-cancel">Cancel</button>
      <button type="button" class="btn btn-danger js-tag-delete-ok">Delete</button>
    </div>
    <div class="tag-row-rename">
      <input class="tag-rename-input" value="${esc(tag.name)}" maxlength="${TAG_NAME_MAX}"
        autocomplete="off" spellcheck="false"
        aria-label="New name for ${esc(tag.name)}" />
      <button type="button" class="btn btn-ghost js-tag-rename-cancel">Cancel</button>
      <button type="button" class="btn btn-primary js-tag-rename-ok">Save</button>
    </div>
  </div>`
}

const showTagManager = () => {
  const cleanup = showExtraModal({
    title: "Tags",
    extraHtml: `
    <div class="tag-manager">
      <div class="tag-manager-new">
        <input id="tag-new-name" class="tag-manager-input" placeholder="New tag name"
          maxlength="${TAG_NAME_MAX}" autocomplete="off" spellcheck="false"
          aria-label="New tag name" />
        <button type="button" class="btn btn-secondary" id="tag-new-add">Add</button>
      </div>
      <div class="tag-manager-head" id="tag-manager-head">
        <span>Show only items with these tags</span>
        <button type="button" class="tag-manager-clear" id="tag-clear">Clear</button>
      </div>
      <div class="tag-manager-list" id="tag-manager-list"></div>
    </div>`,
    okLabel: "Done",
    closeOnly: true,
    okClass: "btn btn-subtle",
    onOk: () => cleanup(),
  })

  const list = document.getElementById("tag-manager-list")
  const nameInp = document.getElementById("tag-new-name")

  const applyFilter = () => {
    applyEntryFilters()
    sortEntries()
    updateTagToggle()
    renderFiles()
  }

  const render = () => {
    list.innerHTML = state.tags.length
      ? state.tags.map(tagRowHtml).join("")
      : `<p class="tag-manager-empty">No tags created yet.</p>`
    document.getElementById("tag-manager-head").classList.toggle("hidden", !state.tags.length)
    document.getElementById("tag-clear").classList.toggle("hidden", !state.tagFilter.size)
  }
  render()

  const addTag = () => {
    if (!createTag(nameInp.value)) return
    nameInp.value = ""
    render()
    nameInp.focus()
  }

  document.getElementById("tag-new-add").onclick = addTag
  document.getElementById("tag-clear").onclick = () => {
    state.tagFilter.clear()
    render()
    applyFilter()
  }

  // A rename that collides with another tag stays open on the offending name for a second try.
  const commitRename = (row, id) => {
    const inp = row.querySelector(".tag-rename-input")
    if (!renameTag(id, inp.value)) {
      inp.focus()
      inp.select()
      return
    }
    render()
    renderFiles()
  }

  // Enter and Escape here work the row being edited; the modal's own handlers would close it.
  document.querySelector(".tag-manager").onkeydown = (e) => {
    const renaming = e.target.closest?.(".tag-row-rename") && e.target.closest(".tag-row")
    if (e.key === "Escape" && renaming) {
      e.stopPropagation()
      renaming.classList.remove("renaming")
      return
    }
    if (e.key !== "Enter") return
    e.stopPropagation()
    if (e.target === nameInp) addTag()
    else if (renaming) commitRename(renaming, renaming.dataset.id)
  }

  list.onclick = (e) => {
    const row = e.target.closest(".tag-row")
    if (!row) return
    const id = row.dataset.id
    if (e.target.closest(".js-tag-color")) {
      cycleTagColor(id)
      render()
      renderFiles()
      return
    }
    if (e.target.closest(".js-tag-filter")) {
      if (state.tagFilter.has(id)) state.tagFilter.delete(id)
      else state.tagFilter.add(id)
      render()
      applyFilter()
      return
    }
    if (e.target.closest(".js-tag-rename")) {
      row.classList.remove("confirming")
      row.classList.add("renaming")
      const inp = row.querySelector(".tag-rename-input")
      inp.value = tagById(id)?.name || ""
      inp.focus()
      inp.select()
      return
    }
    if (e.target.closest(".js-tag-rename-cancel")) {
      row.classList.remove("renaming")
      return
    }
    if (e.target.closest(".js-tag-rename-ok")) {
      commitRename(row, id)
      return
    }
    // The manager owns the only modal, so deleting confirms in the row instead.
    if (e.target.closest(".js-tag-delete")) {
      row.classList.remove("renaming")
      row.classList.add("confirming")
      row.querySelector(".js-tag-delete-cancel").focus()
      return
    }
    if (e.target.closest(".js-tag-delete-cancel")) {
      row.classList.remove("confirming")
      return
    }
    if (e.target.closest(".js-tag-delete-ok")) {
      deleteTag(id)
      render()
      applyFilter()
    }
  }
}

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
  const bar = document.getElementById("preview-tagbar")
  bar.innerHTML = ""
  bar.classList.remove("has-audio")
  document.getElementById("preview-tagslot").innerHTML = ""
  document.getElementById("preview-options").classList.remove("open")
  document.getElementById("preview-view").classList.remove("chrome-hidden", "has-embed")
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

// ─── File Browser ─────────────────────────────────────────────────────────────

const handleHashNavigation = async ({ pushHash = true } = {}) => {
  handledUrl = window.location.href
  let hashPath = currentHashPath()
  // A hash pointing outside the link (stale bookmark, hand-edited URL) snaps back to its root.
  if (!withinHome(hashPath)) {
    hashPath = homePath()
    replacePathHash(hashPath)
  }

  // An unlocked vault answers for its own tree; only its outermost folder exists on the server.
  if (Vault.covers(hashPath)) {
    showBrowser({ pushHash: false })
    applyVaultListing(hashPath, { pushHash })
    return
  }

  // Name alone can't tell folder from file; the listing resolves it.
  let data
  try {
    data = await api("GET", `/api/files?path=${encodeURIComponent(hashPath)}`)
  } catch (e) {
    // A deep link into a locked vault names folders only its index knows; land on the vault itself.
    const climbed = await climbToVault(hashPath)
    if (!climbed) {
      toast(e.message, true)
      return
    }
    state.pendingVaultPath = hashPath
    showBrowser({ pushHash: false })
    applyListing(climbed.path, climbed.data, { pushHash: false })
    replacePathHash(climbed.path)
    return
  }
  if (!data) return

  if (data.notDir) {
    const name = hashPath.split("/").pop()
    // A file link can't list the folder this lives in, so open it on its own instead.
    if (sharedFile()) {
      openLoneFile(hashPath, name)
      return
    }
    const dir = hashPath.slice(0, hashPath.lastIndexOf("/")) || "/"
    await navigate(dir, { pushHash })
    const entry = state.entries.find((e) => e.name === name)
    if (entry) openEntry(entry)
    return
  }

  showBrowser({ pushHash: false })
  applyListing(hashPath, data, { pushHash })
}

// Walk up from a path the server wouldn't list, looking for the vault folder it must live in.
const climbToVault = async (path) => {
  for (let p = parentPath(path); p !== "/"; p = parentPath(p)) {
    const data = await api("GET", `/api/files?path=${encodeURIComponent(p)}`).catch(() => null)
    if (!data || data.notDir) continue
    return data.inVault ? { path: p, data } : null
  }
  return null
}

// An unlocked vault's folders exist only in its index, so it lists itself rather than the server.
const applyVaultListing = (path, { pushHash = true } = {}) => {
  const sub = vaultSubOf(path)
  // A path naming a file: land in its folder and open it, as the server's notDir does.
  if (!Vault.hasDir(sub)) {
    const name = baseName(path)
    applyVaultListing(parentPath(path), { pushHash })
    const entry = state.entries.find((e) => e.name === name)
    if (entry) openEntry(entry)
    else toast("Not found in this vault", true)
    return
  }
  const data = { inVault: true, vaultRoot: Vault.openPath(), entries: Vault.list(sub) }
  applyListing(path, data, { pushHash })
}

const applyListing = (path, data, { pushHash = true } = {}) => {
  state.currentPath = path
  state.inVault = data.inVault === true
  // Only the vault's own folder is a real directory; a subfolder's listing carries its root along.
  state.vaultRoot = state.inVault ? data.vaultRoot || path : null
  // Decrypted bytes must not outlive the vault they came from.
  if (!vaultUnlocked()) releaseVaultBlobs()
  // A locked vault's real listing is ciphertext under random ids; the unlock panel stands in.
  state.allEntries = state.inVault && !vaultUnlocked() ? [] : data.entries || []
  state.inMount = data.inMount === true
  applyEntryFilters()
  loadFolderPrefs()
  sortEntries()
  clearSelection()
  if (pushHash) pushPathHash(path)
  renderBreadcrumb()
  updateViewToggle()
  updateSortToggle()
  updateNewMenu()
  updateVaultToggle()
  renderFiles()
}

// Buckets attach to the top level only, so the option is inert anywhere deeper.
const updateNewMenu = () => {
  const btn = document.getElementById("new-s3-btn")
  btn.disabled = state.currentPath.replace(/\/+$/, "") !== ""
  btn.title = btn.disabled ? "Buckets can only be connected in the top-level folder" : ""
  // A vault's own folder is the only real directory it has; there is nowhere to seal a second one.
  const vault = document.getElementById("new-vault-btn")
  vault.disabled = state.inVault
  vault.title = vault.disabled ? "A vault can't hold another vault" : ""
}

const updateVaultToggle = () => {
  document.getElementById("vault-bar").classList.toggle("hidden", !vaultUnlocked())
  // Search runs on the server, which sees a vault as a folder of ciphertext under random ids.
  const search = document.getElementById("search-btn")
  search.disabled = state.inVault
  search.title = state.inVault ? "A vault's contents can't be searched" : "Search files"
  // Behind the unlock panel there is no listing, so nothing in the toolbar has anything to act on.
  const locked = state.inVault && !vaultUnlocked()
  for (const id of ["new-btn", "upload-btn", "sort-btn", "view-toggle-btn"])
    document.getElementById(id).disabled = locked
}

const navigate = async (path, { pushHash = true } = {}) => {
  if (Vault.covers(path)) {
    applyVaultListing(path, { pushHash })
    return
  }
  try {
    const data = await api("GET", `/api/files?path=${encodeURIComponent(path)}`)
    if (!data) return
    applyListing(path, data, { pushHash })
  } catch (e) {
    toast(e.message, true)
  }
}

const entryHasThumb = (entry) => {
  // A vault decrypts previews in the page, which only pictures are cheap enough for.
  if (state.inVault) return !entry.isDir && fileType(entry.name) === "image"
  if (entry.isDir) return !!entry.hasThumb
  const type = fileType(entry.name)
  return type === "image" || type === "video"
}

// A folder's preview follows the sort saved for that folder itself (default name asc).
const entryFolderSort = (entry) => {
  const p = relPath(entry.name)
  const s = state.sorts[p]
  return { by: s?.by || "name", dir: s?.dir || "asc" }
}

// Size is in the key because an edit keeps the original's date, so URLs would otherwise be reused.
const entryVer = (entry) => `${entry.modified}|${entry.size}`

const entryMediaHtml = (entry) => {
  const type = entry.isDir ? "folder" : fileType(entry.name)
  const rel = relPath(entry.name)
  if (!entryHasThumb(entry)) {
    const icon = `<span class="file-icon">${fileIcon(entry)}</span>`
    // A vault song's length lives behind the server's meta endpoint, which can't read it.
    if (type !== "audio" || state.viewMode !== "grid" || state.inVault) return icon
    // Audio has no thumbnail, so in grid its duration pill rides the type icon.
    const keys = ` data-meta="${encodeURIComponent(rel)}" data-durkey="${esc(rel + entryVer(entry))}"`
    const keyed = `<span class="file-icon"${keys}>${fileIcon(entry)}</span>`
    return `<span class="thumb-wrap">${keyed}<span class="thumb-badge thumb-duration">00:00</span></span>`
  }
  let folderParams = ""
  if (type === "folder") {
    const s = entryFolderSort(entry)
    folderParams = `&e=${thumbEpoch}&sb=${s.by}&sd=${s.dir}`
  }
  // The loader recognizes this scheme and decrypts the blob rather than fetching a URL.
  const src = state.inVault
    ? `${VAULT_SRC}${entry.id}`
    : type === "image" && !THUMB_EXTS.includes(extOf(entry.name))
      ? `/api/files/download?path=${encodeURIComponent(rel)}&inline=1`
      : `/api/files/thumb?path=${encodeURIComponent(rel)}&v=${encodeURIComponent(entryVer(entry))}${folderParams}`
  // Folders and videos get a corner badge, added once the preview loads.
  const badge = type === "folder" || type === "video" ? ` data-badge="${fileIcon(entry)}"` : ""
  const meta = type === "video" ? ` data-meta="${encodeURIComponent(rel)}"` : ""
  const img = `<img class="file-thumb"${badge}${meta} data-src="${src}" data-fallback-icon="${fileIcon(entry)}" draggable="false" alt="" />`
  if (!badge) return img
  // A bucket preview crosses the network, so hold its icon in the slot rather than leave it blank.
  const held = entry.isMount ? `<span class="file-icon thumb-held">${EXT_ICON.mount}</span>` : ""
  // Grid videos flag themselves right away: a 00:00 pill that becomes the duration once fetched.
  const pill =
    type === "video" && state.viewMode === "grid"
      ? `<span class="thumb-badge thumb-duration">00:00</span>`
      : ""
  return `<span class="thumb-wrap">${img}${held}${pill}</span>`
}

// Dots, not chips: a row has no room for names.
const entryTagsHtml = (entry) => {
  // Tags are stored server-side against a path, which inside a vault would be its cleartext name.
  if (state.inVault) return ""
  const tags = tagsFor(relPath(entry.name))
  if (!tags.length) return ""
  const dot = (t) =>
    `<span class="file-tag-dot" style="--tag-color: ${esc(t.color)}" title="${esc(t.name)}"></span>`
  return `<span class="file-tags">${tags.map(dot).join("")}</span>`
}

const defaultViewMode = () => {
  const withThumb = state.entries.filter(entryHasThumb).length
  return withThumb * 2 > state.entries.length ? "grid" : "list"
}

const loadFolderPrefs = () => {
  const savedSort = state.sorts[state.currentPath]
  state.sortBy = savedSort ? savedSort.by : "name"
  state.sortDir = savedSort ? savedSort.dir : "asc"
  state.grouping = state.groupings[state.currentPath] === "mixed" ? "mixed" : "folders"
  state.viewMode = state.viewModes[state.currentPath] || defaultViewMode()
}

// The bar rides inside the scroll container, so it lines up with the list down to its scrollbar.
const renderFiles = () => {
  // Grabbed first: rendering replaces the container's children, which detaches the bar with them.
  const bar = document.getElementById("vault-bar")
  renderFilesContent()
  bar.classList.toggle("vault-bar-grid", state.viewMode === "grid")
  document.getElementById("files-container").prepend(bar)
}

const renderFilesContent = () => {
  updateSelectionUI()
  const container = document.getElementById("files-container")
  if (state.inVault && !vaultUnlocked()) {
    renderVaultLocked(container)
    return
  }
  if (!state.inVault) warmVisibleGains(state.entries, (e) => relPath(e.name))
  if (state.entries.length === 0) {
    const empty = document.createElement("div")
    empty.className = "empty-state"
    // A tag filter empties folders that aren't empty; say so, or the drive looks broken.
    empty.innerHTML =
      state.tagFilter.size && state.allEntries.length
        ? `<div class="icon">🏷️</div><p>No items contain selected tag</p>`
        : `<div class="icon">📂</div><p>This folder is empty</p>`
    container.replaceChildren(empty)
    return
  }
  if (state.viewMode === "grid") {
    renderGrid(container)
  } else {
    renderList(container)
  }
}

// Folder sort and tag colors are folded in, so a re-sort or a recolor repaints the item.
const entrySig = (entry) => {
  const tags = tagsFor(relPath(entry.name))
    .map((t) => t.id + t.color)
    .join(",")

  if (!entry.isDir) {
    return `f|${entry.size}|${entry.modified}|${tags}`
  }

  const s = entryFolderSort(entry)

  return `d|${entry.size}|${entry.modified}|${s.by}|${s.dir}|${tags}`
}

// Reuse existing nodes keyed by name so a rename/move doesn't reload every thumbnail.
const reconcileFiles = (container, wrapId, wrapClass, itemClass, itemHtml) => {
  let wrap = document.getElementById(wrapId)
  if (!wrap) {
    wrap = document.createElement("div")
    wrap.id = wrapId
    wrap.className = wrapClass
    container.replaceChildren(wrap)
  }
  const existing = new Map()
  for (const child of wrap.children) existing.set(child.dataset.name, child)

  const seen = new Set()
  let prev = null
  for (const entry of state.entries) {
    const sig = entrySig(entry)
    let el = existing.get(entry.name)
    if (!el) {
      el = document.createElement("div")
      el.dataset.name = entry.name
      el.dataset.sig = sig
      el.innerHTML = itemHtml(entry)
      bindFileItem(el, entry)
    } else {
      el.__entry = entry
      if (el.dataset.sig !== sig) {
        el.dataset.sig = sig
        el.innerHTML = itemHtml(entry)
      }
    }
    el.className = itemClass + (state.selected.has(entry.name) ? " selected" : "")
    seen.add(entry.name)
    const ref = prev ? prev.nextSibling : wrap.firstChild
    if (ref !== el) wrap.insertBefore(el, ref)
    prev = el
  }
  for (const [name, el] of existing) if (!seen.has(name)) el.remove()
  observeThumbs(wrap)
}

const listItemHtml = (entry) => {
  const audio = !entry.isDir && fileType(entry.name) === "audio"
  const rel = relPath(entry.name)
  // 00:00 holds the cell until the queue fills it.
  const dur = audio
    ? `<span class="file-duration" data-meta="${encodeURIComponent(rel)}" data-durkey="${esc(rel + entryVer(entry))}">00:00</span>`
    : ""
  return `
    <span class="file-media">${entryMediaHtml(entry)}</span>
    <span class="file-name">${esc(displayName(entry))}</span>
    ${entryTagsHtml(entry)}
    <span class="file-meta${audio ? " file-meta-audio" : ""}">
      ${dur}
      ${entry.isDir ? "" : `<span class="file-meta-size">${fmtSize(entry.size)}</span>`}
      <span class="file-meta-date">${fmtDate(entry.modified)}</span>
    </span>`
}

const renderList = (container) =>
  reconcileFiles(container, "file-list", "file-list", "file-item", listItemHtml)

const renderGrid = (container) =>
  reconcileFiles(
    container,
    "file-grid",
    "file-grid",
    "file-card",
    (entry) =>
      `<div class="file-card-media">${entryMediaHtml(entry)}${entryTagsHtml(entry)}</div><span class="file-name">${esc(displayName(entry))}</span>`
  )

// Lazy thumbnail loader: loads near-viewport images a few at a time.
const MAX_CONCURRENT_THUMBS = 3
// Tracked as nodes, not a count, so a re-render can drop the ones that will never settle.
const inFlightThumbs = new Set()
const thumbQueue = []
let thumbObserver = null

// Keyed by thumb src, which busts on v=modified; thumbless audio carries its own path+mtime key.
const mediaDurations = new Map()
const fillDuration = async (el, { retry, final } = {}) => {
  // A list row's duration is a cell of its own, so there the queued node is the target itself.
  const cell = el.classList.contains("file-duration")
  const pill = cell ? el : el.parentElement?.querySelector(".thumb-duration")
  if (!pill) return
  const key = el.dataset.durkey || el.src
  const request = () =>
    api("GET", `/api/files/meta?path=${el.dataset.meta}`)
      .then((m) => m?.duration || 0)
      .catch(() => 0)
  if (!mediaDurations.has(key)) mediaDurations.set(key, request())
  let secs = await mediaDurations.get(key)
  // Generation may have just sidecared a duration (webm/mkv/avi) the first fetch was too early for.
  if (retry && !secs) {
    mediaDurations.set(key, request())
    secs = await mediaDurations.get(key)
  }
  if (!pill.isConnected) return
  if (secs) pill.textContent = fmtDuration(secs)
  else if (final) pill.textContent = cell ? "—" : "▶︎" // settled: a track of unknown length
}

const pumpThumbQueue = () => {
  while (inFlightThumbs.size < MAX_CONCURRENT_THUMBS && thumbQueue.length > 0) {
    // Newest first: after a fast scroll the tail is what's on screen and the head is far behind.
    const img = thumbQueue.pop()
    if (!img.isConnected) continue
    // Audio rides the same queue with no image to load: only the meta fetch behind its pill.
    if (img.dataset.durkey) {
      inFlightThumbs.add(img)
      fillDuration(img, { final: true }).finally(() => {
        delete img.dataset.durkey
        inFlightThumbs.delete(img)
        pumpThumbQueue()
      })
      continue
    }
    const src = img.dataset.src
    if (!src) continue
    thumbObserver?.unobserve(img)
    inFlightThumbs.add(img)
    delete img.dataset.src
    const done = () => {
      inFlightThumbs.delete(img)
      pumpThumbQueue()
    }
    img.addEventListener(
      "load",
      () => {
        // Add the badge now that the preview is confirmed, to avoid a flash.
        const wrap = img.parentElement
        if (wrap?.classList.contains("thumb-wrap")) {
          wrap.querySelector(".thumb-held")?.remove()
          if (!wrap.querySelector(".thumb-badge")) {
            const badge = document.createElement("span")
            badge.className = "thumb-badge"
            badge.textContent = img.dataset.badge
            wrap.appendChild(badge)
          }
          if (img.dataset.meta) fillDuration(img, { retry: true, final: true })
        }
        done()
      },
      { once: true }
    )
    img.addEventListener(
      "error",
      () => {
        // The 🎬 fallback icon already says video; don't stack the pill on top of it.
        img.parentElement?.querySelector(".thumb-duration")?.remove()
        const held = img.parentElement?.querySelector(".thumb-held")
        if (held) {
          // The held icon is already the right one; drop the image so it stays put, unchanged.
          held.classList.remove("thumb-held")
          img.remove()
          done()
          return
        }
        // Unthumbnailable: show the type icon instead of a broken-image glyph.
        const span = document.createElement("span")
        span.className = "file-icon"
        span.textContent = img.dataset.fallbackIcon || "📄"
        img.replaceWith(span)
        done()
      },
      { once: true }
    )
    // A vault thumbnail has no URL to fetch: the blob is decrypted here and shown from memory.
    if (src.startsWith(VAULT_SRC)) {
      vaultBlobUrl(src.slice(VAULT_SRC.length)).then(
        (url) => (img.isConnected ? (img.src = url) : done()),
        () => img.dispatchEvent(new Event("error"))
      )
      continue
    }
    img.src = src
    if (img.dataset.meta) fillDuration(img)
  }
}

const observeThumbs = (container) => {
  if (thumbObserver) thumbObserver.disconnect()
  thumbQueue.length = 0
  // A re-rendered node never fires load/error, so it would hold its slot forever.
  for (const img of inFlightThumbs) if (!img.isConnected) inFlightThumbs.delete(img)
  thumbObserver = new IntersectionObserver(
    (entries) => {
      const entering = []
      for (const e of entries) {
        if (!e.target.dataset.src && !e.target.dataset.durkey) continue
        const i = thumbQueue.indexOf(e.target)
        if (e.isIntersecting) {
          if (i < 0) entering.push(e)
        } else if (i >= 0) {
          // Scrolled past before its turn: drop it so the backlog can't outlive the viewport.
          thumbQueue.splice(i, 1)
        }
      }
      // The queue pops from the tail, so sort bottom-right first to load top-down, left to right.
      entering.sort(
        (a, b) =>
          b.boundingClientRect.top - a.boundingClientRect.top ||
          b.boundingClientRect.left - a.boundingClientRect.left
      )
      for (const e of entering) thumbQueue.push(e.target)
      pumpThumbQueue()
    },
    // Root must be the scroll container so rootMargin's preload isn't clipped.
    { root: document.getElementById("files-container"), rootMargin: "600px 0px" }
  )
  for (const el of container.querySelectorAll("img.file-thumb[data-src], [data-durkey]")) {
    thumbObserver.observe(el)
  }
}

const bindFileItem = (el, entry) => {
  el.__entry = entry
  el.addEventListener("pointerdown", (e) => beginGesture(e, el, el.__entry))

  el.addEventListener("click", (e) => {
    if (suppressNextClick) {
      suppressNextClick = false
      return
    }
    const entry = el.__entry
    const idx = state.entries.indexOf(entry)

    if (e.shiftKey && state.lastClickIdx !== null) {
      const lo = Math.min(state.lastClickIdx, idx)
      const hi = Math.max(state.lastClickIdx, idx)
      state.selected.clear()
      for (let i = lo; i <= hi; i++) state.selected.add(state.entries[i].name)
      updateSelectionHighlights()
      updateSelectionUI()
      return
    }

    if (e.ctrlKey || e.metaKey) {
      if (state.selected.has(entry.name)) {
        state.selected.delete(entry.name)
      } else {
        state.selected.add(entry.name)
      }
      state.lastClickIdx = idx
      updateSelectionHighlights()
      updateSelectionUI()
      return
    }

    if (state.selected.size === 1 && state.selected.has(entry.name)) {
      openEntry(entry)
      return
    }

    state.selected.clear()
    state.selected.add(entry.name)
    state.lastClickIdx = idx
    updateSelectionHighlights()
    updateSelectionUI()
  })
}

const updateViewToggle = () => {
  const grid = state.viewMode === "grid"
  const btn = document.getElementById("view-toggle-btn")
  btn.querySelector("use").setAttribute("href", grid ? "#icon-grid" : "#icon-list")
  btn.title = grid ? "Grid view" : "List view"
}

// The direction each field reads most naturally in; picking the field in use just reverses it.
const SORT_FIRST_DIR = { name: "asc", date: "desc", size: "desc" }

const nextSortDir = (by) =>
  by === state.sortBy ? (state.sortDir === "asc" ? "desc" : "asc") : SORT_FIRST_DIR[by]

const updateSortToggle = () => {
  const desc = state.sortDir === "desc"
  const label = { date: "Date", size: "Size" }
  document.getElementById("sort-btn-label").textContent = label[state.sortBy] || "Name"
  document.getElementById("sort-dir").classList.toggle("desc", desc)
  document.querySelectorAll(".sort-popover-item[data-sort]").forEach((item) => {
    const active = item.dataset.sort === state.sortBy
    item.classList.toggle("active", active)
    item.classList.toggle("desc", active && desc)
  })
  document.querySelectorAll(".sort-popover-item[data-toggle]").forEach((item) => {
    const on = item.dataset.toggle === "group" ? state.grouping === "folders" : state.showHidden
    item.classList.toggle("active", on)
    item.setAttribute("aria-checked", String(on))
  })
}

const updateTagToggle = () => {
  const filtering = state.tagFilter.size
  const btn = document.getElementById("sort-btn")
  btn.classList.toggle("filtering", filtering > 0)
  btn.title = filtering
    ? `Sort — filtered by ${filtering} tag${filtering === 1 ? "" : "s"}`
    : "Sort"
  document.getElementById("sort-tags-count").textContent = filtering || ""
  document.getElementById("sort-tags-btn").classList.toggle("active", filtering > 0)
}

const updateSelectionHighlights = () => {
  document.querySelectorAll(".file-item, .file-card").forEach((el) => {
    el.classList.toggle("selected", state.selected.has(el.dataset.name))
  })
}

const getSelectedEntries = () => {
  return state.entries.filter((e) => state.selected.has(e.name))
}

const updateSelectionUI = () => {
  const n = state.selected.size
  const single = n === 1

  const selected = getSelectedEntries()
  // The trash is the server's bookkeeping, not a folder: nothing in the toolbar applies to it.
  const trash = selected.some((e) => e.isTrash)

  const dis = (id, off) => {
    document.getElementById(id).disabled = off
  }
  dis("rename-btn", !single || trash)
  dis("details-btn", !single || trash)
  dis("options-btn", n === 0 || trash)
  dis("delete-btn", n === 0 || trash)
  // One path only; inside a vault that path is the cleartext name the server must not learn.
  dis("options-tags-btn", !single || trash || state.inVault)
  dis("options-share-btn", !single || trash || state.inVault)
  dis("options-move-btn", n === 0 || trash)
  // A vault's blobs are only ever rewritten in place, so there is no copy of one to make.
  dis("options-copy-btn", n === 0 || trash || state.inVault)
  // A vault download is handed over from memory, one decrypted file at a time — no server zip.
  dis("options-download-btn", state.inVault && !(single && !selected[0].isDir))

  const tool = selectionTool(selected)
  document.getElementById("options-tool-btn").classList.toggle("hidden", !tool)
  if (tool) document.getElementById("options-tool-label").textContent = tool.label

  const total = state.entries.length
  const label = n > 0 ? `${n} selected` : `${total} item${total === 1 ? "" : "s"}`
  // Folders report no size, so a folder-only selection sums to 0; show nothing rather than 0 B.
  const bytes = (n > 0 ? selected : state.entries).reduce((sum, e) => sum + e.size, 0)
  document.getElementById("selection-count").textContent = label
  document.getElementById("selection-size").textContent = bytes ? fmtSize(bytes) : ""
}

const clearSelection = () => {
  state.selected.clear()
  state.lastClickIdx = null
  updateSelectionHighlights()
  updateSelectionUI()
}

const selectAll = () => {
  // Skip the trash, or select-all at the root would disable the very actions it was used for.
  for (const entry of state.entries) if (!entry.isTrash) state.selected.add(entry.name)
  updateSelectionHighlights()
  updateSelectionUI()
}

const openLoneFile = (path, name) => {
  const type = fileType(name)
  if (type === "pdf" && !EMBEDS_PDF) {
    const url = `/api/files/download?path=${encodeURIComponent(path)}&inline=1`
    // Deep links reach here outside a user gesture, where the popup blocker kills window.open.
    if (!window.open(url, "_blank")) location.href = url
    return
  }
  if (isMedia(name) || type === "pdf" || previewsBlank(name)) openPreview(path, name, type)
  else openEditor(path, name)
}

const openEntry = async (entry) => {
  if (entry.isDir) {
    const newPath = relPath(entry.name)
    navigate(newPath)
    return
  }
  const rel = relPath(entry.name)
  // A vault's PDF has to be handed over as decrypted bytes, since the URL would serve ciphertext.
  if (fileType(entry.name) === "pdf" && !EMBEDS_PDF && state.inVault) {
    const url = await vaultBlobUrl(entry.id).catch((e) => toast(e.message, true))
    if (!url) return
    if (!window.open(url, "_blank")) location.href = url
    return
  }
  openLoneFile(rel, entry.name)
}

const moveEntriesToDir = async (entries, destDir) => {
  const cleanDest = "/" + destDir.replace(/^\/+|\/+$/g, "")
  if (state.inVault) return moveWithinVault(entries, cleanDest)
  let moved = 0
  for (const entry of entries) {
    const from = relPath(entry.name)
    const to = joinPath(cleanDest, entry.name)
    if (from === to) continue
    try {
      await api("POST", "/api/files/move", { from, to })
      retagPath(from, to)
      moved++
    } catch (e) {
      toast(`Failed to move “${entry.name}”: ${e.message}`, true)
    }
  }
  if (moved > 0) {
    state.selected.clear()
    toast(`Moved ${moved} item${moved === 1 ? "" : "s"}`)
    navigate(state.currentPath)
  }
}

// A move inside a vault only rewrites the index: the blobs never leave the one folder they sit in.
const moveWithinVault = async (entries, destDir) => {
  if (!Vault.covers(destDir)) {
    toast("Files can't be moved out of a vault", true)
    return
  }
  let moved = 0
  try {
    moved = await Vault.move(
      vaultSub(),
      entries.map((e) => e.name),
      vaultSubOf(destDir)
    )
  } catch (e) {
    toast(e.message, true)
    return
  }
  const skipped = entries.length - moved
  if (!moved) {
    toast("That name is already taken at the destination", true)
    return
  }
  state.selected.clear()
  const left = skipped ? `, ${skipped} left behind — the name was taken` : ""
  toast(`Moved ${moved} item${moved === 1 ? "" : "s"}${left}`, skipped > 0)
  navigate(state.currentPath)
}

const copyEntriesToDir = async (entries, destDir) => {
  const cleanDest = "/" + destDir.replace(/^\/+|\/+$/g, "")
  let copied = 0
  for (const entry of entries) {
    const from = entryPath(entry)
    const to = joinPath(cleanDest, entry.name)
    if (from === to) continue
    try {
      await api("POST", "/api/files/copy", { from, to })
      copied++
    } catch (e) {
      toast(`Failed to copy “${entry.name}”: ${e.message}`, true)
    }
  }
  if (copied > 0) {
    state.selected.clear()
    toast(`Copied ${copied} item${copied === 1 ? "" : "s"}`)
    navigate(state.currentPath)
  }
}

// ─── Folder picker ────────────────────────────────────────────────────────────

const pickerRowHtml = (entry) => `
  <button type="button" class="picker-row" data-name="${esc(entry.name)}">
    <span class="file-icon">${fileIcon(entry)}</span>
    <span class="picker-row-name">${esc(entry.name)}</span>
    <svg class="picker-row-chevron" aria-hidden="true"><use href="#icon-chevron-right" /></svg>
  </button>`

// blocked names folders the destination can't be: a folder can't be moved inside itself.
const showFolderPicker = ({ title, okLabel, start, blocked = [], onPick }) => {
  let at = withinHome(start) ? start : homePath()
  const inVault = Vault.covers(at)

  const cleanup = showExtraModal({
    title,
    wide: true,
    okLabel,
    extraHtml: `
    <div class="picker">
      <div class="picker-head">
        <button type="button" class="btn btn-ghost picker-up" id="picker-up" aria-label="Up one folder">
          <svg class="btn-icon" aria-hidden="true"><use href="#icon-arrow-left" /></svg>
        </button>
        <span class="picker-path" id="picker-path"></span>
        <button type="button" class="btn btn-ghost" id="picker-new" title="New folder" aria-label="New folder">
          <svg class="btn-icon" aria-hidden="true"><use href="#icon-folder-plus" /></svg>
        </button>
      </div>
      <div class="picker-new-row hidden" id="picker-new-row">
        <input id="picker-new-name" placeholder="Folder name" aria-label="New folder name" />
        <button type="button" class="btn btn-secondary" id="picker-new-ok">Create</button>
      </div>
      <div class="picker-list" id="picker-list"></div>
    </div>`,
    onOk: () => {
      cleanup()
      onPick(at)
    },
  })

  const listEl = document.getElementById("picker-list")
  const pathEl = document.getElementById("picker-path")
  const newRow = document.getElementById("picker-new-row")
  const newName = document.getElementById("picker-new-name")

  const note = (text) => {
    listEl.innerHTML = `<p class="picker-note">${esc(text)}</p>`
  }

  const render = async () => {
    pathEl.textContent =
      at === homePath() ? (state.share ? state.share.name : "Home") : baseName(at)
    pathEl.title = at
    document.getElementById("picker-up").disabled = at === homePath()
    let entries
    if (inVault) {
      entries = Vault.list(vaultSubOf(at))
    } else {
      try {
        const data = await api("GET", `/api/files?path=${encodeURIComponent(at)}`)
        entries = data?.entries || []
      } catch (e) {
        note(e.message)
        return
      }
    }
    const dirs = entries.filter(
      (e) =>
        e.isDir &&
        !e.isTrash &&
        !e.isVault &&
        (state.showHidden || !e.name.startsWith(".")) &&
        !blocked.includes(joinPath(at, e.name))
    )
    if (!dirs.length) note("No folders here")
    else listEl.innerHTML = dirs.map(pickerRowHtml).join("")
  }

  listEl.onclick = (e) => {
    const row = e.target.closest(".picker-row")
    if (!row) return
    at = joinPath(at, row.dataset.name)
    render()
  }

  document.getElementById("picker-up").onclick = () => {
    if (at === homePath()) return
    at = parentPath(at)
    if (!withinHome(at)) at = homePath()
    render()
  }

  const createFolder = async () => {
    const name = newName.value.trim()
    if (!name) return
    try {
      const made = inVault
        ? await Vault.mkdir(vaultSubOf(at), name, { unique: true })
        : (await api("POST", "/api/files/mkdir", { path: joinPath(at, name), unique: true }))?.name
      newRow.classList.add("hidden")
      newName.value = ""
      at = joinPath(at, made || name)
      render()
    } catch (err) {
      toast(err.message, true)
    }
  }

  document.getElementById("picker-new").onclick = () => {
    newRow.classList.toggle("hidden")
    if (!newRow.classList.contains("hidden")) newName.focus()
  }
  document.getElementById("picker-new-ok").onclick = createFolder
  // The dialog shell would read Enter as "pick this folder" and close on the folder's own name.
  newName.onkeydown = (e) => {
    e.stopPropagation()
    if (e.key === "Enter") createFolder()
    if (e.key === "Escape") newRow.classList.add("hidden")
  }

  render()
}

const pickerBlocked = (entries) => entries.filter((e) => e.isDir).map((e) => entryPath(e))

const showMoveTo = (entries) => {
  if (!entries.length) return
  showFolderPicker({
    title: entries.length === 1 ? `Move “${entries[0].name}”` : `Move ${entries.length} items`,
    okLabel: "Move here",
    start: state.currentPath,
    blocked: pickerBlocked(entries),
    onPick: (dest) => {
      if (dest === entryDir(entries[0])) return
      moveEntriesToDir(entries, dest)
    },
  })
}

const showCopyTo = (entries) => {
  if (!entries.length) return
  showFolderPicker({
    title: entries.length === 1 ? `Copy “${entries[0].name}”` : `Copy ${entries.length} items`,
    okLabel: "Copy here",
    start: state.currentPath,
    blocked: pickerBlocked(entries),
    onPick: (dest) => copyEntriesToDir(entries, dest),
  })
}

// ─── Drag to move ───────────────────────────────────────────────────────────────

let drag = null // active drag session: { entries, ghost, target }
let gesture = null // pending gesture before a drag starts
let suppressNextClick = false // swallow the click that follows a drag

const startDrag = (entry, x, y) => {
  let entries
  if (state.selected.has(entry.name)) {
    entries = getSelectedEntries().filter((e) => !e.isTrash)
    if (!entries.length) return
  } else {
    state.selected.clear()
    state.selected.add(entry.name)
    updateSelectionHighlights()
    updateSelectionUI()
    entries = [entry]
  }
  const ghost = document.createElement("div")
  ghost.className = "drag-ghost"
  ghost.textContent = entries.length === 1 ? entries[0].name : `${entries.length} items`
  document.body.appendChild(ghost)
  drag = { entries, ghost, target: null, touch: gesture?.touch, x, y, scrollV: 0, scrollRAF: null }
  document.body.classList.add("dragging")
  moveGhost(x, y)
}

const resolveDropTarget = (el) => {
  if (!el || !drag) return null
  const item = el.closest(".file-item, .file-card")
  if (item) {
    const name = item.dataset.name
    const entry = state.entries.find((e) => e.name === name)
    if (entry && entry.isDir && !entry.isTrash && !drag.entries.some((d) => d.name === name)) {
      const dir = relPath(name)
      return { el: item, dir }
    }
    return null
  }
  const crumb = el.closest("#breadcrumb a[data-path]")
  if (crumb) return { el: crumb, dir: crumb.dataset.path }
  return null
}

const refreshDropTarget = (x, y) => {
  const target = resolveDropTarget(document.elementFromPoint(x, y))
  const curEl = drag.target && drag.target.el
  const newEl = target && target.el
  if (curEl !== newEl) {
    if (curEl) curEl.classList.remove("drop-target")
    if (newEl) newEl.classList.add("drop-target")
    drag.target = target
  }
}

const moveGhost = (x, y) => {
  if (!drag) return
  drag.x = x
  drag.y = y
  // On touch the finger covers below the point, so float the ghost centered above it.
  drag.ghost.style.transform = drag.touch
    ? `translate(${x}px, ${y}px) translate(-50%, calc(-100% - 24px))`
    : `translate(${x + 14}px, ${y + 14}px)`
  refreshDropTarget(x, y)
  updateAutoScroll()
}

// Scroll the list while a drag hovers its top/bottom edge, to reach off-screen dirs.
const AUTOSCROLL_ZONE = 72 // px from an edge where scrolling kicks in
const AUTOSCROLL_MAX = 16 // px per frame at the very edge

const updateAutoScroll = () => {
  if (!drag) return
  const el = document.getElementById("files-container")
  if (!el) return
  const r = el.getBoundingClientRect()
  let v = 0
  // Autoscroll up over the toolbar and list top, but not the topbar/breadcrumbs above it.
  const crumbs = document.querySelector(".breadcrumb-row")
  const topLimit = crumbs ? crumbs.getBoundingClientRect().bottom : r.top
  if (drag.y >= topLimit && drag.y < r.top + AUTOSCROLL_ZONE) {
    v = -AUTOSCROLL_MAX * Math.min(1, (r.top + AUTOSCROLL_ZONE - drag.y) / AUTOSCROLL_ZONE)
  } else if (drag.y > r.bottom - AUTOSCROLL_ZONE) {
    v = AUTOSCROLL_MAX * Math.min(1, (drag.y - (r.bottom - AUTOSCROLL_ZONE)) / AUTOSCROLL_ZONE)
  }
  drag.scrollV = v
  if (v && !drag.scrollRAF) {
    const step = () => {
      if (!drag || !drag.scrollV) {
        if (drag) drag.scrollRAF = null
        return
      }
      const before = el.scrollTop
      el.scrollTop += drag.scrollV
      // Content moved under a stationary point, so re-evaluate the hovered target.
      if (el.scrollTop !== before) refreshDropTarget(drag.x, drag.y)
      drag.scrollRAF = requestAnimationFrame(step)
    }
    drag.scrollRAF = requestAnimationFrame(step)
  }
}

const endDrag = (commit) => {
  if (!drag) return
  const d = drag
  drag = null
  if (d.scrollRAF) cancelAnimationFrame(d.scrollRAF)
  if (d.target) d.target.el.classList.remove("drop-target")
  d.ghost.remove()
  document.body.classList.remove("dragging")
  suppressNextClick = true
  setTimeout(() => {
    suppressNextClick = false
  }, 350)
  if (commit && d.target) moveEntriesToDir(d.entries, d.target.dir)
}

const onGestureMove = (e) => {
  if (!gesture) return
  const dist = Math.hypot(e.clientX - gesture.startX, e.clientY - gesture.startY)
  if (!drag) {
    if (!gesture.armed) {
      // Touch, before long-press completes: movement means the user is scrolling.
      if (dist > 10) endGesture(false)
      return
    }
    if (!gesture.touch && dist < 6) return // mouse needs a small threshold
    gesture.el.classList.remove("drag-armed")
    startDrag(gesture.entry, e.clientX, e.clientY)
  }
  moveGhost(e.clientX, e.clientY)
}

const endGesture = (commit) => {
  if (!gesture) return
  clearTimeout(gesture.pressTimer)
  gesture.el.classList.remove("drag-armed")
  window.removeEventListener("pointermove", onGestureMove)
  window.removeEventListener("pointerup", onGestureUp)
  window.removeEventListener("pointercancel", onGestureCancel)
  gesture = null
  if (drag) endDrag(commit)
}

const onGestureUp = () => endGesture(true)
const onGestureCancel = () => endGesture(false)

const beginGesture = (e, el, entry) => {
  if (e.button !== undefined && e.button !== 0) return // left button / touch only
  if (!canEdit()) return // dragging exists only to move things
  if (entry.isTrash) return
  gesture = {
    entry,
    el,
    startX: e.clientX,
    startY: e.clientY,
    touch: e.pointerType === "touch",
    armed: e.pointerType !== "touch", // mouse is armed immediately
    pressTimer: null,
  }
  if (gesture.touch) {
    gesture.pressTimer = setTimeout(() => {
      if (!gesture) return
      gesture.armed = true
      if (navigator.vibrate) navigator.vibrate(15)
      el.classList.add("drag-armed")
    }, 450)
  }
  window.addEventListener("pointermove", onGestureMove)
  window.addEventListener("pointerup", onGestureUp)
  window.addEventListener("pointercancel", onGestureCancel)
}

// ─── Upload ───────────────────────────────────────────────────────────────────

// XHR instead of fetch: only XHR exposes upload progress, so big files don't look hung.
const uploadOne = (file, path, onProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", `/api/files/upload?path=${encodeURIComponent(path)}`)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded)
    }
    xhr.onload = () => {
      if (xhr.status === 401) {
        if (isShareUrl()) showShareGone()
        else showLogin()
        resolve(null)
        return
      }
      let data = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {}
      if (xhr.status >= 200 && xhr.status < 300) {
        thumbEpoch++
        resolve(data)
      } else {
        reject(new Error(data?.error || xhr.statusText))
      }
    }
    xhr.onerror = () => reject(new Error("network error"))
    const fd = new FormData()
    // Appended before the file: the server reads parts in order and stamps files as they land.
    if (file.lastModified) fd.append("lastModified", String(file.lastModified))
    fd.append("files", file)
    xhr.send(fd)
  })

// ─── Resumable upload ─────────────────────────────────────────────────────────

// 8 MB: per-chunk overhead is noise, and a dropped connection costs seconds, not the whole file.
const CHUNK_BYTES = 8 << 20
const CHUNK_RETRIES = 4

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Two rounds so the id doesn't collide on name alone; crypto.subtle needs a secure context.
const strHash = (s) => {
  let a = 0x811c9dc5
  let b = 0x1000193
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    a = Math.imul(a ^ c, 16777619) >>> 0
    b = Math.imul(b + c, 2246822519) >>> 0
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0")
}

// Derived from the file itself, so a re-send finds its own half-written part on the server.
const uploadId = (file) =>
  strHash(`${file.name} ${file.size}`) +
  strHash(`${file.lastModified || 0} ${file.name}`) +
  file.size.toString(16)

const sendChunk = (url, blob, onProgress) =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open("POST", url)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded)
    }
    xhr.onload = () => {
      let data = null
      try {
        data = JSON.parse(xhr.responseText)
      } catch {}
      if (xhr.status === 401) {
        if (isShareUrl()) showShareGone()
        else showLogin()
        resolve({ gone: true })
      } else if (xhr.status === 409 && typeof data?.offset === "number") {
        // The server is the authority on what actually landed; re-sync rather than guess.
        resolve({ resync: data.offset })
      } else if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ data })
      } else {
        reject(new Error(data?.error || xhr.statusText))
      }
    }
    xhr.onerror = () => reject(new Error("network error"))
    xhr.send(blob)
  })

const uploadResumable = async (file, path, onProgress) => {
  const id = uploadId(file)
  const base = `path=${encodeURIComponent(path)}&id=${id}`

  let offset = 0
  try {
    const st = await api("GET", `/api/files/upload/status?${base}`)
    if (typeof st?.offset === "number" && st.offset <= file.size) offset = st.offset
  } catch {
    // No part to resume into — a bucket, or the probe itself failed. Send it in one piece.
    return uploadOne(file, path, onProgress)
  }
  if (offset) toast(`Resuming “${file.name}” at ${fmtSize(offset)}`)

  let attempt = 0
  for (;;) {
    const end = Math.min(offset + CHUNK_BYTES, file.size)
    const last = end >= file.size
    const url =
      `/api/files/upload/chunk?${base}&offset=${offset}&name=${encodeURIComponent(file.name)}` +
      `&lastModified=${file.lastModified || 0}${last ? "&last=1" : ""}`

    const at = offset
    let res
    try {
      res = await sendChunk(url, file.slice(offset, end), (loaded) => onProgress(at + loaded))
    } catch (e) {
      if (++attempt > CHUNK_RETRIES) throw e
      await sleep(500 * 2 ** (attempt - 1))
      continue
    }
    if (res.gone) return null
    if (res.resync !== undefined) {
      offset = res.resync
      if (++attempt > CHUNK_RETRIES) throw new Error("the upload kept losing its place")
      continue
    }
    attempt = 0
    offset = typeof res.data?.offset === "number" ? res.data.offset : end
    onProgress(offset)
    if (last) {
      thumbEpoch++
      return res.data
    }
  }
}

// Small files go up in one request: chunking them buys nothing and costs a round-trip to ask.
const putFile = (file, path, onProgress) =>
  file.size > CHUNK_BYTES && !state.inVault
    ? uploadResumable(file, path, onProgress)
    : uploadOne(file, path, onProgress)

// Directory picking is desktop-only; iOS Safari has no webkitdirectory to offer.
const canPickFolders = () => "webkitdirectory" in HTMLInputElement.prototype

// Folders are carried separately from the files so empty ones survive.
const asUpload = (files, dirs = []) => ({
  files: Array.from(files).map((file) => {
    const rel = file.webkitRelativePath || ""
    return { file, relDir: rel.slice(0, Math.max(0, rel.lastIndexOf("/"))) }
  }),
  dirs,
})

const under = (path, rel) => (rel ? joinPath(path, rel) : path)

// readEntries hands back one slice per call, so it is drained until it comes up empty.
const readEntries = (reader) =>
  new Promise((ok, fail) => reader.readEntries(ok, fail)).then(async (batch) =>
    batch.length ? batch.concat(await readEntries(reader)) : []
  )

// dataTransfer empties when the handler returns, so entries are taken up front and walked after.
const droppedUpload = async (dataTransfer) => {
  const roots = Array.from(dataTransfer.items || [])
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean)
  if (!roots.length) return asUpload(dataTransfer.files)

  const files = []
  const dirs = []
  let unreadable = 0
  const walk = async (entry, relDir) => {
    if (entry.isFile) {
      try {
        files.push({ file: await new Promise((ok, fail) => entry.file(ok, fail)), relDir })
      } catch {
        unreadable++
      }
      return
    }
    // Joined by hand: these must read like webkitRelativePath, with no leading slash.
    const dir = relDir ? `${relDir}/${entry.name}` : entry.name
    dirs.push(dir)
    for (const child of await readEntries(entry.createReader())) await walk(child, dir)
  }
  for (const root of roots) await walk(root, "")

  if (unreadable) toast(`${unreadable} file(s) could not be read and were skipped`, true)
  return { files, dirs }
}

// Every folder an upload needs, parents first, so none is made before the one holding it.
const uploadDirs = ({ files, dirs }) => {
  const all = new Set()
  for (const dir of [...files.map((f) => f.relDir), ...dirs]) {
    const parts = dir.split("/").filter(Boolean)
    for (let i = 1; i <= parts.length; i++) all.add(parts.slice(0, i).join("/"))
  }
  return [...all].sort((a, b) => a.split("/").length - b.split("/").length)
}

// Makes them, mapping each to where it landed: a clashing top-level name is suffixed, not merged.
const makeUploadDirs = async (upload, mkdir) => {
  const real = new Map([["", ""]])
  const renamed = []
  for (const dir of uploadDirs(upload)) {
    const cut = dir.lastIndexOf("/")
    const parent = cut < 0 ? "" : dir.slice(0, cut)
    const name = dir.slice(cut + 1)
    const at = real.get(parent)
    if (at === undefined) continue // its parent failed, and the whole subtree goes with it
    try {
      const made = await mkdir(at, name, parent === "")
      if (parent === "" && made !== name) renamed.push(made)
      real.set(dir, under(at, made))
    } catch (e) {
      toast(`Could not create “${dir}”: ${e.message}`, true)
    }
  }
  if (renamed.length === 1) toast(`Name taken — folder saved as “${renamed[0]}”`)
  else if (renamed.length > 1) toast(`${renamed.length} folders renamed to avoid overwriting`)
  return real
}

const uploadFiles = async (upload, path) => {
  const { files } = upload
  if (!files.length && !upload.dirs.length) return
  // A vault encrypts in the page first, so it can't ride the plain multipart upload path.
  if (state.inVault) return uploadToVault(upload, path)
  const total = files.length
  const progressEl = document.getElementById("upload-progress")
  const titleEl = document.getElementById("upload-progress-title")
  const barEl = document.getElementById("progress-bar-fill")
  const labelEl = document.getElementById("progress-label")
  const renamed = []
  const totalBytes = files.reduce((n, f) => n + f.file.size, 0) || 1
  let doneBytes = 0

  progressEl.classList.add("active")
  barEl.style.width = "0%"
  titleEl.textContent = "Preparing…"
  labelEl.textContent = ""

  const dirs = await makeUploadDirs(upload, async (at, name, unique) => {
    const res = await api("POST", "/api/files/mkdir", {
      path: joinPath(under(path, at), name),
      unique,
    })
    return res?.name || name
  })
  // Show the new folders at once; the files inside them aren't on screen to trickle in.
  const madeDirs = dirs.size > 1
  if (madeDirs && state.currentPath === path) await navigate(path)

  for (let i = 0; i < files.length; i++) {
    const { file, relDir } = files[i]
    const dest = dirs.get(relDir)
    if (dest === undefined) {
      doneBytes += file.size // its folder could not be made, so there is nowhere to put it
      continue
    }
    titleEl.textContent = `Uploading “${file.name}”`
    labelEl.textContent = `${i + 1} / ${total}`

    try {
      const res = await putFile(file, under(path, dest), (loaded) => {
        barEl.style.width = `${Math.round(((doneBytes + loaded) / totalBytes) * 100)}%`
      })
      const savedAs = res?.saved?.[0]
      if (savedAs && savedAs !== file.name) renamed.push(savedAs)
      // Refresh per file so bulk uploads appear as they land, unless the user browsed elsewhere.
      if (res && !relDir && state.currentPath === path) await navigate(path)
    } catch (e) {
      toast(`Failed to upload “${file.name}”: ${e.message}`, true)
    }
    doneBytes += file.size
  }

  if (madeDirs && state.currentPath === path) await navigate(path)

  if (renamed.length === 1) toast(`Name taken — saved as “${renamed[0]}”`)
  else if (renamed.length > 1) toast(`${renamed.length} files renamed to avoid overwriting`)

  barEl.style.width = "100%"
  labelEl.textContent = "Done"
  setTimeout(() => {
    progressEl.classList.remove("active")
    barEl.style.width = "0"
  }, 1500)
}

// ─── Download ─────────────────────────────────────────────────────────────────

let activeZips = 0
let zipBytes = 0

// The zip is built on the fly, so only the bytes that have landed are knowable — no percentage.
const downloadZip = async (paths) => {
  const panelEl = document.getElementById("download-progress")
  const titleEl = document.getElementById("download-progress-title")
  const barEl = document.getElementById("download-bar-fill")
  const labelEl = document.getElementById("download-label")

  activeZips++
  titleEl.textContent =
    activeZips === 1 ? "Preparing download…" : `Preparing ${activeZips} downloads…`
  labelEl.textContent = fmtSize(zipBytes)
  barEl.style.width = ""
  barEl.classList.add("indeterminate")
  panelEl.classList.add("active")

  let failed = false
  try {
    const res = await fetch("/api/files/zip", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths }),
    })
    if (!res.ok) throw new Error("zip download failed")

    let blob
    if (res.body?.getReader) {
      const reader = res.body.getReader()
      const chunks = []
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        zipBytes += value.length
        labelEl.textContent = fmtSize(zipBytes)
      }
      blob = new Blob(chunks, { type: "application/zip" })
    } else {
      blob = await res.blob()
      zipBytes += blob.size
    }

    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "download.zip"
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) {
    failed = true
    toast(e.message, true)
  }

  if (--activeZips > 0) {
    titleEl.textContent =
      activeZips === 1 ? "Preparing download…" : `Preparing ${activeZips} downloads…`
    return
  }

  zipBytes = 0
  barEl.classList.remove("indeterminate")
  if (failed) {
    panelEl.classList.remove("active")
    return
  }
  titleEl.textContent = "Download ready"
  barEl.style.width = "100%"
  labelEl.textContent = "Done"
  setTimeout(() => {
    if (activeZips > 0) return
    panelEl.classList.remove("active")
    barEl.style.width = "0"
  }, 1500)
}

// ─── Drag & Drop ──────────────────────────────────────────────────────────────

const setupDragDrop = () => {
  const overlay = document.getElementById("drop-overlay")
  let depth = 0

  document.addEventListener("dragenter", (e) => {
    if (!e.dataTransfer.types.includes("Files") || !canEdit()) return
    depth++
    overlay.classList.add("active")
  })

  document.addEventListener("dragleave", () => {
    depth--
    if (depth <= 0) {
      depth = 0
      overlay.classList.remove("active")
    }
  })

  document.addEventListener("dragover", (e) => {
    e.preventDefault()
  })

  document.addEventListener("drop", async (e) => {
    e.preventDefault()
    depth = 0
    overlay.classList.remove("active")
    const view = document.getElementById("browser-view")
    if (view.classList.contains("hidden") || !canEdit()) return
    uploadFiles(await droppedUpload(e.dataTransfer), state.currentPath)
  })
}

// ─── Editor ───────────────────────────────────────────────────────────────────

// Toast UI popups ignore mousedowns on their own trigger; toggle them closed on click.
const wireToolbarPopoverToggle = (root) => {
  if (root.dataset.toggleWired) return
  root.dataset.toggleWired = "1"

  const menuOpen = () =>
    [".toastui-editor-popup", ".toastui-editor-dropdown-toolbar"].some((sel) => {
      const el = root.querySelector(sel)
      return el && el.offsetParent !== null
    })

  // Re-anchor popups to the button's on-screen rect; Toast UI ignores horizontal scroll.
  const repositionPopup = (btn) => {
    const popup = root.querySelector(".toastui-editor-popup")
    if (!popup || popup.offsetParent === null) return
    const parent = popup.offsetParent
    const parentLeft = parent.getBoundingClientRect().left
    const btnLeft = btn.getBoundingClientRect().left
    const pad = 8
    const maxLeft = parent.clientWidth - popup.offsetWidth - pad
    popup.style.left = `${Math.max(pad, Math.min(btnLeft - parentLeft, maxLeft))}px`
  }

  let activeBtn = null
  root.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest(".toastui-editor-toolbar-icons")
      if (!btn) return
      if (btn === activeBtn && menuOpen()) {
        document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }))
        activeBtn = null
        e.preventDefault()
        e.stopImmediatePropagation()
      } else {
        activeBtn = btn
        requestAnimationFrame(() => repositionPopup(btn))
      }
    },
    true
  )
}

// Prose gets autocorrect/spellcheck; keep them off inside code so tokens aren't mangled.
const enableEditorInputAssist = (root, view) => {
  const editable = root.querySelector(".toastui-editor-ww-container .ProseMirror")
  if (!editable || !view) return
  editable.setAttribute("spellcheck", "true")
  editable.setAttribute("autocorrect", "on")
  editable.setAttribute("autocapitalize", "sentences")

  const OFF = { spellcheck: "false", autocorrect: "off", autocapitalize: "off" }
  const stamp = (el) => el && Object.entries(OFF).forEach(([k, v]) => el.setAttribute(k, v))

  // Attrs must come from the render; writing them onto live DOM makes ProseMirror loop.
  const codeSpec = view.state.schema.marks.code.spec
  const codeToDOM = codeSpec.toDOM
  codeSpec.toDOM = function () {
    const dom = codeToDOM.apply(this, arguments)
    Object.assign((dom[1] = dom[1] || {}), OFF)
    return dom
  }

  // Fenced code uses a node view, not toDOM; patch the prop, as reconfigure rebuilds from it.
  const nodeViewProps = view._props?.nodeViews
  const codeBlockView = nodeViewProps?.codeBlock
  if (!codeBlockView) return
  const wrapped = function () {
    const nv = codeBlockView.apply(this, arguments)
    stamp(nv.dom)
    stamp(nv.contentDOM)
    return nv
  }
  nodeViewProps.codeBlock = wrapped
  view.nodeViews.codeBlock = wrapped
}

// Toast UI's list Backspace drops the caret at the next line's start; join into the previous line.
const patchListBackspace = (root, view) => {
  if (!view) return
  const container = root.querySelector(".toastui-editor-ww-container")
  if (!container) return
  container.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Backspace" || e.isComposing) return
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      const { state } = view
      const sel = state.selection
      if (!sel.empty || sel.$from.parentOffset !== 0) return
      const $from = sel.$from
      let inListItem = false
      for (let d = $from.depth; d > 0; d--) {
        if ($from.node(d).type.name === "listItem") {
          inListItem = true
          break
        }
      }
      if (!inListItem) return
      let target = null
      for (let p = $from.pos - 1; p > 0; p--) {
        if (state.doc.resolve(p).parent.isTextblock) {
          target = p
          break
        }
      }
      if (target == null) return
      const tr = state.tr.deleteRange(target, $from.pos)
      if (!tr.docChanged) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const pos = tr.mapping.map(target, -1)
      tr.setSelection(sel.constructor.create(tr.doc, pos))
      view.dispatch(tr.scrollIntoView())
    },
    true
  )
}

const hideLinkPopover = () => {
  document.getElementById("link-popover").classList.add("hidden")
}

// Goes through a ProseMirror transaction; a direct DOM edit is discarded on re-render.
const setLink = (anchor, url, text) => {
  const view = state.mdeInstance?.wwEditor?.view
  const linkMark = view?.state.schema.marks.link
  if (!view || !linkMark) return
  const from = view.posAtDOM(anchor, 0)
  const to = view.posAtDOM(anchor, anchor.childNodes.length)

  let baseMarks = []
  let attrs = { linkUrl: url }
  view.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return
    if (!baseMarks.length) baseMarks = node.marks
    const m = node.marks.find((mk) => mk.type === linkMark)
    if (m) attrs = { ...m.attrs, linkUrl: url }
  })
  const linkAttr = linkMark.create(attrs)

  const tr = view.state.tr
  if (text && text !== anchor.textContent) {
    // Replacing the text collapses to the link's leading marks; keep any others.
    const marks = baseMarks.filter((m) => m.type !== linkMark).concat(linkAttr)
    tr.replaceRangeWith(from, to, view.state.schema.text(text, marks))
  } else {
    tr.removeMark(from, to, linkMark).addMark(from, to, linkAttr)
  }
  view.dispatch(tr)
}

const removeLink = (anchor) => {
  const view = state.mdeInstance?.wwEditor?.view
  const linkMark = view?.state.schema.marks.link
  if (!view || !linkMark) return
  const from = view.posAtDOM(anchor, 0)
  const to = view.posAtDOM(anchor, anchor.childNodes.length)
  view.dispatch(view.state.tr.removeMark(from, to, linkMark))
}

const showLinkEdit = (anchor) => {
  const cleanup = showExtraModal({
    title: "Edit link",
    extraHtml: `
    <div class="link-edit-fields">
      <label class="link-edit-field">
        <span>Text</span>
        <input id="link-edit-text" value="${esc(anchor.textContent)}" />
      </label>
      <label class="link-edit-field">
        <span>URL</span>
        <input id="link-edit-url" value="${esc(anchor.getAttribute("href") || "")}" placeholder="https://example.com" />
      </label>
    </div>`,
    okLabel: "Save",
    onOk: () => {
      const url = urlInp.value.trim()
      const text = textInp.value.trim()
      cleanup()
      if (url) setLink(anchor, url, text)
    },
  })
  const textInp = document.getElementById("link-edit-text")
  const urlInp = document.getElementById("link-edit-url")
  textInp.focus()
  textInp.setSelectionRange(textInp.value.length, textInp.value.length)
}

const showLinkPopover = (anchor) => {
  const pop = document.getElementById("link-popover")
  const openBtn = document.getElementById("link-popover-open")
  const copyBtn = document.getElementById("link-popover-copy")
  const editBtn = document.getElementById("link-popover-edit")
  const removeBtn = document.getElementById("link-popover-remove")
  openBtn.href = anchor.href
  openBtn.onclick = () => hideLinkPopover()
  copyBtn.onclick = async () => {
    hideLinkPopover()
    try {
      await navigator.clipboard.writeText(anchor.href)
      toast("Link copied")
    } catch {
      toast("Couldn't copy link", true)
    }
  }
  editBtn.onclick = () => {
    hideLinkPopover()
    showLinkEdit(anchor)
  }
  removeBtn.onclick = () => {
    hideLinkPopover()
    removeLink(anchor)
  }

  pop.classList.remove("hidden")
  const rect = anchor.getBoundingClientRect()
  const gap =
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--popover-gap")) || 6
  let left = rect.left
  let top = rect.bottom + gap
  if (left + pop.offsetWidth > window.innerWidth - 8) {
    left = window.innerWidth - 8 - pop.offsetWidth
  }
  if (top + pop.offsetHeight > window.innerHeight - 8) {
    top = rect.top - gap - pop.offsetHeight
  }
  pop.style.left = `${Math.max(8, left)}px`
  pop.style.top = `${Math.max(8, top)}px`
}

const enableEditorLinks = (root) => {
  const container = root.querySelector(".toastui-editor-ww-container")
  if (!container) return
  container.addEventListener(
    "click",
    (e) => {
      const anchor = e.target.closest?.("a[href]")
      if (!anchor || !container.contains(anchor)) return
      // Ctrl/Cmd+click skips the popover and opens the link directly.
      const openDirect = e.ctrlKey || e.metaKey
      if (!openDirect && (e.altKey || e.shiftKey)) return
      e.preventDefault()
      e.stopPropagation()
      if (openDirect) window.open(anchor.href, "_blank", "noopener,noreferrer")
      else showLinkPopover(anchor)
    },
    true
  )
}

// Toast UI ignores stored marks, so toggling bold on an empty selection leaves the button unlit.
const TOOLBAR_MARK_KEYS = ["strong", "emph", "strike", "code"]
const reflectPendingMarksInToolbar = (mde) => {
  const emitter = mde.eventEmitter
  const emit = emitter.emit.bind(emitter)
  emitter.emit = (type, ...args) => {
    if (type === "changeToolbarState" && mde.isWysiwygMode?.()) {
      const st = args[0]?.toolbarState
      const pm = mde.wwEditor?.view?.state
      const sel = pm?.selection
      if (st && sel?.empty) {
        for (const m of pm.storedMarks || sel.$from.marks()) {
          if (TOOLBAR_MARK_KEYS.includes(m.type.name))
            st[m.type.name] = { ...st[m.type.name], active: true }
        }
      }
    }
    return emit(type, ...args)
  }
}

// ─── Editor color picker ─────────────────────────────────────────────────────

const hslToHex = (h, s, l) => {
  s /= 100
  l /= 100
  const f = (n) => {
    const k = (n + h / 30) % 12
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, "0")
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

const rgbToHsl = (r, g, b) => {
  r /= 255
  g /= 255
  b /= 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d) {
    if (max === r) h = (((g - b) / d) % 6) * 60
    else if (max === g) h = ((b - r) / d + 2) * 60
    else h = ((r - g) / d + 4) * 60
    if (h < 0) h += 360
  }
  return [Math.round(h), Math.round(s * 100), Math.round(l * 100)]
}

const hexToHsl = (str) => {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec(str.trim())
  if (!m) return null
  let v = m[1]
  if (v.length === 3) v = [...v].map((c) => c + c).join("")
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16))
  return rgbToHsl(r, g, b)
}

const cssColorToHsl = (str) => {
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(str)
  return rgb ? rgbToHsl(+rgb[1], +rgb[2], +rgb[3]) : hexToHsl(str)
}

// First color span at the selection, so the popup opens preloaded with it.
const colorAtSelection = (pmState) => {
  const { from, to, empty, $from } = pmState.selection
  let style = empty
    ? ""
    : (() => {
        let found = ""
        pmState.doc.nodesBetween(from, to, (node) => {
          if (found || !node.isText) return
          const mark = node.marks.find((mk) => mk.type.name === "span")
          if (mark) found = mark.attrs?.htmlAttrs?.style || ""
        })
        return found
      })()
  if (!style && empty) {
    const mark = $from.marks().find((mk) => mk.type.name === "span")
    style = mark?.attrs?.htmlAttrs?.style || ""
  }
  const c = /color:\s*([^;]+)/.exec(style)?.[1]
  return c ? cssColorToHsl(c.trim()) : null
}

const setupColorPicker = (mdWrap, toolbarEl, wwView) => {
  // Snapshot the selection on popup-open; clicking in the popup collapses the live one.
  let colorRange = null
  let selectionHsl = null
  toolbarEl?.addEventListener(
    "mousedown",
    (e) => {
      if (!e.target.closest(".toastui-editor-toolbar-icons.color")) return
      const s = wwView?.state.selection
      colorRange = s ? { from: s.from, to: s.to } : null
      selectionHsl = s ? colorAtSelection(wwView.state) : null
    },
    true
  )
  const colorTargetRange = (pmState) => {
    const r = colorRange || pmState.selection
    return r.from === r.to ? null : r
  }
  // Firefox shrinks the selection when marked nodes redraw while the popup has focus.
  const restoreColorSelection = (r) => {
    setTimeout(() => {
      const view = state.mdeInstance?.wwEditor?.view
      if (!view || r.to > view.state.doc.content.size) return
      view.focus()
      const tr = view.state.tr
      tr.setSelection(view.state.selection.constructor.create(tr.doc, r.from, r.to))
      view.dispatch(tr)
    })
  }
  // Override colorSyntax's command so color lands on the snapshot, not the collapsed selection.
  state.mdeInstance.addCommand("wysiwyg", "color", (payload, pmState, dispatch) => {
    const color = payload?.selectedColor
    const r = color && colorTargetRange(pmState)
    if (!r) return false
    const mark = pmState.schema.marks.span.create({ htmlAttrs: { style: `color: ${color}` } })
    const tr = pmState.tr.addMark(r.from, r.to, mark)
    tr.setSelection(pmState.selection.constructor.create(tr.doc, r.from, r.to))
    dispatch(tr)
    restoreColorSelection(r)
    return true
  })

  // Replace the vendor detail picker (hidden in CSS) with HSL sliders and hex/HSL fields.
  let setPopupHsl = null
  const injectColorControls = () => {
    const popup = mdWrap.querySelector(".toastui-editor-popup-color")
    const okBtn = popup?.querySelector("button")
    if (!okBtn || popup.querySelector(".editor-hsl")) return

    const hsl = document.createElement("div")
    hsl.className = "editor-hsl"
    hsl.innerHTML = `
      <div class="editor-hsl-row"><span>H</span><input type="range" min="0" max="360" value="210"></div>
      <div class="editor-hsl-row"><span>S</span><input type="range" min="0" max="100" value="60"></div>
      <div class="editor-hsl-row"><span>L</span><input type="range" min="0" max="100" value="45"></div>
      <div class="editor-hsl-row editor-hsl-sep"><span>Hex</span><input type="text" class="editor-hsl-hex" spellcheck="false"><span class="editor-hsl-chip"></span></div>
      <div class="editor-hsl-row"><span>HSL</span><input type="text" class="editor-hsl-hsl" spellcheck="false"></div>`
    const [hInp, sInp, lInp] = hsl.querySelectorAll("input[type=range]")
    const hexInp = hsl.querySelector(".editor-hsl-hex")
    const hslInp = hsl.querySelector(".editor-hsl-hsl")
    const chip = hsl.querySelector(".editor-hsl-chip")
    let hex = ""
    const sync = (src) => {
      const [h, s, l] = [+hInp.value, +sInp.value, +lInp.value]
      hex = hslToHex(h, s, l)
      // Longhand keeps the stylesheet's background-clip; the shorthand would reset it.
      sInp.style.backgroundImage = `linear-gradient(to right, hsl(${h},0%,${l}%), hsl(${h},100%,${l}%))`
      lInp.style.backgroundImage = `linear-gradient(to right, #000, hsl(${h},${s}%,50%), #fff)`
      hInp.style.setProperty("--thumb", `hsl(${h},100%,50%)`)
      sInp.style.setProperty("--thumb", hex)
      lInp.style.setProperty("--thumb", hex)
      chip.style.background = hex
      if (src !== hexInp) hexInp.value = hex
      if (src !== hslInp) hslInp.value = `${h}, ${s}%, ${l}%`
    }
    setPopupHsl = ([h, s, l]) => {
      hInp.value = h
      sInp.value = s
      lInp.value = l
      sync()
    }
    hsl.addEventListener("input", (e) => {
      if (e.target === hexInp) {
        const p = hexToHsl(hexInp.value)
        if (!p) return
        ;[hInp.value, sInp.value, lInp.value] = p
        sync(hexInp)
      } else if (e.target === hslInp) {
        const n = (hslInp.value.match(/\d+(\.\d+)?/g) || []).map(Number)
        if (n.length < 3) return
        hInp.value = Math.min(360, n[0])
        sInp.value = Math.min(100, n[1])
        lInp.value = Math.min(100, n[2])
        sync(hslInp)
      } else sync()
    })
    hsl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault()
        okBtn.click()
      }
    })
    sync()
    okBtn.before(hsl)
    okBtn.addEventListener("click", (e) => {
      // Stop the plugin's delegated handler; OK applies our slider color, not the vendor picker's.
      e.stopPropagation()
      state.mdeInstance.eventEmitter.emit("command", "color", { selectedColor: hex })
      state.mdeInstance.eventEmitter.emit("closePopup")
      state.mdeInstance.wwEditor?.view?.focus()
    })

    // colorSyntax can't clear a color, so add a reset button too.
    const reset = document.createElement("button")
    reset.type = "button"
    reset.className = "editor-color-reset btn btn-secondary"
    reset.textContent = "Reset"
    reset.addEventListener("click", (e) => {
      // Stop the plugin's delegated handler from re-applying the picked color.
      e.stopPropagation()
      const view = state.mdeInstance.wwEditor?.view
      const spanMark = view?.state.schema.marks.span
      const r = view && colorTargetRange(view.state)
      if (spanMark && r) {
        const tr = view.state.tr.removeMark(r.from, r.to, spanMark)
        tr.setSelection(view.state.selection.constructor.create(tr.doc, r.from, r.to))
        view.dispatch(tr)
        restoreColorSelection(r)
      }
      state.mdeInstance.eventEmitter.emit("closePopup")
      view?.focus()
    })
    okBtn.classList.add("btn", "btn-primary")
    const actions = document.createElement("div")
    actions.className = "editor-color-actions"
    okBtn.before(actions)
    actions.append(okBtn, reset)
  }
  injectColorControls()
  toolbarEl?.querySelector(".toastui-editor-toolbar-icons.color")?.addEventListener("click", () =>
    queueMicrotask(() => {
      injectColorControls()
      if (selectionHsl) setPopupHsl?.(selectionHsl)
      // The button tooltip overlaps the open popup; vendor re-shows it on next hover.
      document.querySelector(".toastui-editor-tooltip")?.style.setProperty("display", "none")
    })
  )
}

const currentEditorEntry = () => state.entries.find((e) => relPath(e.name) === state.editorPath)

// A shared file has no listing row; only Download and Details work without one.
const updateEditorOptions = () => {
  const entry = currentEditorEntry()
  const wrap = document.querySelector(".editor-options-wrap")
  if (!entry) {
    const lone = sharedFile()
    wrap.classList.toggle("hidden", !lone)
    if (!lone) return
    for (const el of wrap.querySelectorAll(".popover-item")) el.classList.add("hidden")
    document.getElementById("editor-details-btn").classList.remove("hidden")
    const dl = document.getElementById("editor-download-btn")
    dl.classList.remove("hidden")
    dl.href = `/api/files/download?path=${encodeURIComponent(state.editorPath)}`
    dl.download = baseName(state.editorPath)
    return
  }
  wrap.classList.remove("hidden")
  // A vault's point is keeping this name off the server; tags and links are the owner's alone.
  const withheld = state.inVault || !!state.share
  document.getElementById("editor-tags-btn").classList.toggle("hidden", withheld)
  document.getElementById("editor-share-btn").classList.toggle("hidden", withheld)
  const dl = document.getElementById("editor-download-btn")
  dl.download = entry.name
  if (state.inVault) {
    vaultBlobUrl(entry.id).then(
      (url) => (dl.href = url),
      () => {}
    )
    return
  }
  dl.href = `/api/files/download?path=${encodeURIComponent(state.editorPath)}`
}

// Every doc change dispatches, so refuse there; selection-only ones pass, to keep text copyable.
const sealEditorView = (view) => {
  view.setProps({ editable: () => false })
  // setProps alone leaves the attribute as it was, and the browser goes by the attribute.
  view.dom.contentEditable = "false"
  const pass = view.dispatch.bind(view)
  view.dispatch = (tr) => {
    if (!tr.docChanged) pass(tr)
  }
}

const openEditor = async (path, name) => {
  const token = Symbol()
  state.editorToken = token

  showEditorView()
  state.viewPushedHistory = pushPathHash(path)
  document.getElementById("editor-filename").textContent = name
  document.getElementById("editor-status").textContent = ""
  state.editorPath = path
  state.editorDirty = false
  updateEditorOptions()

  const textEl = document.getElementById("text-editor")
  const mdWrap = document.getElementById("md-editor-wrap")

  textEl.classList.add("hidden")
  mdWrap.classList.add("hidden")
  if (state.mdeInstance) {
    state.mdeInstance.destroy()
    state.mdeInstance = null
  }

  try {
    let content
    if (state.inVault) {
      const entry = state.entries.find((e) => e.name === name)
      if (!entry) throw new Error("not found in this vault")
      content = new TextDecoder().decode((await Vault.readFile(entry.id)).bytes)
    } else {
      const data = await api("GET", `/api/files/read?path=${encodeURIComponent(path)}`)
      if (!data) return
      content = data.content
    }
    if (state.editorToken !== token) return
    const type = fileType(name)
    state.editorType = type

    if (type === "markdown") {
      mdWrap.classList.remove("hidden")
      mdWrap.innerHTML = ""

      const historyItem = (command, label) => ({
        name: command,
        command,
        tooltip: label,
        className: `toastui-editor-toolbar-icons editor-${command}`,
      })

      const clientWidthDesc = Object.getOwnPropertyDescriptor(Element.prototype, "clientWidth")
      // Report an unbounded clientWidth so Toast UI keeps every toolbar item in one row.
      Object.defineProperty(Element.prototype, "clientWidth", {
        configurable: true,
        get() {
          return this.classList?.contains("toastui-editor-defaultUI-toolbar")
            ? 1000000
            : clientWidthDesc.get.call(this)
        },
      })
      state.mdeInstance = new toastui.Editor({
        el: mdWrap,
        height: "100%",
        initialEditType: "wysiwyg",
        initialValue: "",
        hideModeSwitch: true,
        autofocus: false,
        plugins: [
          [
            toastui.Editor.plugin.colorSyntax,
            {
              preset: [
                "#181818",
                "#585858",
                "#B8B8B8",
                "#F8F8F8",
                "#E00909",
                "#E08209",
                "#4EAA1B",
                "#1693B0",
                "#1A68CC",
                "#B16EB4",
              ],
            },
          ],
        ],
        toolbarItems: [
          ["heading", "bold", "italic", "strike"],
          ["ul", "ol", "task", "outdent", "indent"],
          ["hr", "table", "code", "link"],
        ],
      })
      Object.defineProperty(Element.prototype, "clientWidth", clientWidthDesc)
      const toolbarEl = mdWrap.querySelector(".toastui-editor-defaultUI-toolbar")
      if (toolbarEl) {
        Object.defineProperty(toolbarEl, "clientWidth", {
          configurable: true,
          get: () => 1000000,
        })
      }
      // Added after construction so colorSyntax's fixed-index button lands correctly.
      state.mdeInstance.insertToolbarItem(
        { groupIndex: 0, itemIndex: 0 },
        historyItem("undo", "Undo")
      )
      state.mdeInstance.insertToolbarItem(
        { groupIndex: 0, itemIndex: 1 },
        historyItem("redo", "Redo")
      )

      const wwView = state.mdeInstance.wwEditor?.view
      const historyPluginOf = (view) =>
        view.state.plugins.find((p) => {
          const s = p.getState?.(view.state)
          return s && s.done && typeof s.done.eventCount === "number"
        })

      reflectPendingMarksInToolbar(state.mdeInstance)
      // Assist attrs are installed into the renderer, so content must load after.
      enableEditorInputAssist(mdWrap, wwView)
      // Second arg is cursorToEnd; leaving it on scrolls a long file to the bottom.
      state.mdeInstance.setMarkdown(content, false)
      if (!content) state.mdeInstance.moveCursorToStart(true)
      // Toast UI has no read-only mode; a view-only link gets the rendered doc without the tools.
      if (!canEdit()) {
        mdWrap.classList.add("md-readonly")
        // The source view is sealed too: it sits behind a mode switch we merely hide.
        for (const v of [wwView, state.mdeInstance.mdEditor?.view]) if (v) sealEditorView(v)
      }

      // Reset ProseMirror history so undo can't wipe the initially loaded content.
      if (wwView) {
        const historyPlugin = historyPluginOf(wwView)
        if (historyPlugin) {
          const idx = wwView.state.plugins.indexOf(historyPlugin)
          wwView.updateState(
            wwView.state.reconfigure({
              plugins: wwView.state.plugins.filter((p) => p !== historyPlugin),
            })
          )
          const restored = wwView.state.plugins.slice()
          restored.splice(idx, 0, historyPlugin)
          wwView.updateState(wwView.state.reconfigure({ plugins: restored }))
        }
      }

      const syncHistoryButtons = () => {
        const hs = wwView && historyPluginOf(wwView)?.getState(wwView.state)
        if (!hs) return
        const undoBtn = toolbarEl?.querySelector(".editor-undo")
        const redoBtn = toolbarEl?.querySelector(".editor-redo")
        const undoOff = hs.done.eventCount === 0
        const redoOff = hs.undone.eventCount === 0
        if (undoBtn && undoBtn.disabled !== undoOff) undoBtn.disabled = undoOff
        if (redoBtn && redoBtn.disabled !== redoOff) redoBtn.disabled = redoOff
      }
      syncHistoryButtons()
      // Re-sync on every toolbar change; Toast UI's relayout resets button disabled state.
      if (toolbarEl) {
        new MutationObserver(syncHistoryButtons).observe(toolbarEl, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["disabled"],
        })
      }

      setupColorPicker(mdWrap, toolbarEl, wwView)

      state.editorSavedContent = state.mdeInstance.getMarkdown()
      state.mdeInstance.on("change", () => {
        refreshEditorStatus()
        syncHistoryButtons()
      })
      mdWrap.addEventListener(
        "keydown",
        (e) => {
          const mod = e.ctrlKey || e.metaKey
          // Intercept Ctrl+S before Toast UI's keymap binds it to strikethrough.
          if (mod && e.key === "s") {
            e.preventDefault()
            e.stopPropagation()
            if (canEdit()) saveEditor()
          } else if (mod && !e.shiftKey && !e.altKey && (e.key === "y" || e.key === "Y")) {
            // Toast UI ships only Ctrl+Shift+Z for redo; add the Windows/Linux Ctrl+Y too.
            e.preventDefault()
            e.stopPropagation()
            state.mdeInstance?.exec("redo")
          }
        },
        true
      )
      wireToolbarPopoverToggle(mdWrap)
      patchListBackspace(mdWrap, wwView)
      enableEditorLinks(mdWrap)
      requestAnimationFrame(() => {
        const mdScrollEl = mdWrap.querySelector(".toastui-editor-main-container")
        if (mdScrollEl) mdScrollEl.scrollTop = 0
      })
    } else {
      textEl.classList.remove("hidden")
      textEl.readOnly = !canEdit()
      textEl.value = content
      state.editorSavedContent = content
      textEl.setSelectionRange(0, 0)
      textEl.scrollTop = 0
      textEl.focus()
    }
  } catch (e) {
    toast(e.message, true)
  }
}

const currentEditorContent = () => {
  if (state.editorType === "markdown" && state.mdeInstance) return state.mdeInstance.getMarkdown()
  return document.getElementById("text-editor").value
}

// Dirty state is derived from content so undoing back to saved clears it.
const refreshEditorStatus = () => {
  const status = document.getElementById("editor-status")
  state.editorDirty = currentEditorContent() !== state.editorSavedContent
  if (state.editorDirty) status.textContent = "• Unsaved"
  else if (status.textContent === "• Unsaved") status.textContent = ""
}

const saveEditor = async () => {
  const content = currentEditorContent()
  try {
    if (state.inVault) {
      const entry = currentEditorEntry()
      if (!entry) throw new Error("This file is no longer in the vault.")
      await Vault.writeFile(entry.id, new TextEncoder().encode(content))
      releaseVaultBlob(entry.id) // the download link still points at the bytes as they were
      updateEditorOptions()
    } else {
      await api("POST", `/api/files/write?path=${encodeURIComponent(state.editorPath)}`, {
        content,
      })
    }
    state.editorSavedContent = content
    state.editorDirty = false
    document.getElementById("editor-status").textContent = "Saved"
    setTimeout(() => {
      document.getElementById("editor-status").textContent = ""
    }, 2000)
  } catch (e) {
    toast(e.message, true)
  }
}

// Go back through history when leaving a view so Back doesn't reopen it.
const goBackToBrowser = () => {
  // No listing to fall back to: Esc and the swipes would strand the visitor outside the link.
  if (sharedFile()) return
  // Back re-routes asynchronously; without this the player runs on until the listing lands.
  silencePreview()
  if (state.viewPushedHistory) {
    history.back()
    return
  }
  replacePathHash(state.currentPath)
  showBrowser({ pushHash: false })
}

const editorBack = () => {
  if (state.editorDirty && !confirm("Discard unsaved changes?")) return
  goBackToBrowser()
}

// Back re-routes and refetches, so only the in-place exit has to refresh the listing itself.
const deleteOpenEntry = (entry) =>
  deleteEntries([entry], {
    after: () => {
      const refetches = state.viewPushedHistory
      goBackToBrowser()
      if (!refetches) navigate(state.currentPath, { pushHash: false })
    },
  })

// A name the editor can't hold — a media extension — drops us back out to the listing.
const reopenEditorRenamed = (name) => {
  const entry = state.entries.find((e) => e.name === name)
  if (!entry || isMedia(name) || ["pdf", "archive"].includes(fileType(name))) {
    goBackToBrowser()
    return
  }
  state.editorPath = relPath(name)
  replacePathHash(state.editorPath)
  document.getElementById("editor-filename").textContent = name
  updateEditorOptions()
}

// ─── Preview ──────────────────────────────────────────────────────────────────

// Warm neighbors' display JPEGs so paging, and the server build behind it, stays ahead of the user.
const prefetchNeighborDisplays = () => {
  if (state.inVault) return // there is no server-side re-encode of a file the server can't read
  for (const delta of [1, -1]) {
    const e = state.previewFiles[state.previewIdx + delta]
    if (!e || !DISPLAY_EXTS.includes(extOf(e.name))) continue
    // warm=1 makes the server build without redirecting us to the multi-MB original.
    new Image().src = `/api/files/display?path=${encodeURIComponent(relPath(e.name))}&v=${encodeURIComponent(entryVer(e))}&warm=1`
  }
}

const THUMB_MAX = 320 // the server's thumb cap; a thumb under it was never scaled, so is the original

// A thumb stands in on the full image's rect, which would stretch a small original to that box.
const pinSmallStandIn = (img) => {
  const pin = () => {
    if (!img.naturalWidth || Math.max(img.naturalWidth, img.naturalHeight) >= THUMB_MAX) return
    img.style.maxWidth = `${img.naturalWidth}px`
    img.style.maxHeight = `${img.naturalHeight}px`
  }
  if (img.complete) pin()
  else img.addEventListener("load", pin, { once: true })
}

const DISPLAY_MAX = 1920 // the server's display cap; anything larger came back as the original

// An unbuilt display redirects to the original, which iOS repaints dark on transform; poll for it.
const upgradeToDisplay = async (img, displayUrl) => {
  if (Math.max(img.naturalWidth, img.naturalHeight) <= DISPLAY_MAX) return
  for (let wait = 500; wait < 16000; wait *= 2) {
    await new Promise((r) => setTimeout(r, wait))
    if (!img.isConnected) return
    // warm=1 answers 204 while the build runs and the JPEG itself once it's ready.
    const res = await fetch(`${displayUrl}&warm=1`).catch(() => null)
    if (!res || res.status !== 200) continue
    const blobUrl = URL.createObjectURL(await res.blob())
    const next = new Image()
    next.src = blobUrl
    // Decoded before it's swapped in, so the picture never blinks through the change.
    await next.decode().catch(() => {})
    if (img.isConnected && next.naturalWidth) {
      img.addEventListener("load", () => URL.revokeObjectURL(blobUrl), { once: true })
      img.src = blobUrl
    } else {
      URL.revokeObjectURL(blobUrl)
    }
    return
  }
}

// Shared with the swipe peeks, so a URL a swipe pulled is cached when the file opens for real.
const previewSrcs = (entry, path, name, type) => {
  // A vault file is already decrypted into a blob; there is no URL, poster or re-encode behind it.
  if (state.inVault) {
    return { original: (entry && vaultBlobs.get(entry.id)) || "", thumb: "", display: "" }
  }
  const v = entry ? `&v=${encodeURIComponent(entryVer(entry))}` : ""
  return {
    // Stamped too: a same-named replacement reuses this URL, and the browser has the old file.
    original: isRaw(name)
      ? `/api/files/preview?path=${encodeURIComponent(path)}`
      : `/api/files/download?path=${encodeURIComponent(path)}&inline=1${v}`,
    // Same URL the grid used, so it paints from cache: poster for video, stand-in for an image.
    thumb:
      entry && entryHasThumb(entry) ? `/api/files/thumb?path=${encodeURIComponent(path)}${v}` : "",
    // Multi-MP originals load slowly and iOS Safari composites them dark; show a 1920px re-encode.
    display:
      entry && type === "image" && DISPLAY_EXTS.includes(extOf(name))
        ? `/api/files/display?path=${encodeURIComponent(path)}${v}`
        : "",
  }
}

const openPreview = async (path, name, type, { replace = false, paging = false } = {}) => {
  const entry = state.entries.find((e) => e.name === name)
  // A file the viewer won't paint has nothing to stall for, so its download does the decrypting.
  const lazyVault = state.inVault && entry && previewsBlank(name)
  if (state.inVault && entry && !lazyVault) {
    try {
      await vaultBlobUrl(entry.id)
    } catch (e) {
      toast(e.message, true)
      return
    }
  }
  // Leaving a song settles the verdict tagging owes it, and silences it unless another follows.
  if (state.previewType === "audio") {
    settleTagging(false)
    if (type !== "audio") stopAudio()
  }
  showPreviewView()
  // Paging replaces the hash in place so the viewer stays one history entry.
  if (replace) {
    replacePathHash(path)
  } else {
    state.viewPushedHistory = pushPathHash(path)
  }
  document.getElementById("preview-filename").textContent = name
  const dlBtn = document.getElementById("preview-download-btn")
  dlBtn.href =
    state.inVault && entry
      ? vaultBlobs.get(entry.id) || ""
      : `/api/files/download?path=${encodeURIComponent(path)}`
  dlBtn.download = name
  // Assigned, not added: each open replaces the last one's handler rather than stacking on it.
  dlBtn.onclick = lazyVault
    ? (e) => {
        e.preventDefault()
        saveVaultFile(entry)
      }
    : null
  const body = document.getElementById("preview-body")
  const {
    original: url,
    thumb: thumbUrl,
    display: displayUrl,
  } = previewSrcs(entry, path, name, type)
  if (type === "image") {
    body.innerHTML = thumbUrl
      ? `<img class="preview-placeholder" src="${esc(thumbUrl)}" alt="">`
      : ""
    const standIn = body.querySelector(".preview-placeholder")
    if (standIn) pinSmallStandIn(standIn)
  } else if (type === "video") {
    const poster = thumbUrl ? ` poster="${esc(thumbUrl)}"` : ""
    body.innerHTML = `<video controls autoplay playsinline preload="metadata"${poster}><source src="${esc(url)}"><p>Your browser does not support this video.</p></video>`
  } else if (type === "audio") {
    const player = audioPlayer() || buildAudioPlayer()
    player.src = url
    // Re-inserting the element drops iOS's lock screen session; clear around it, not through it.
    for (const node of [...body.childNodes]) if (node !== player) node.remove()
    if (player.parentNode !== body) body.appendChild(player)
    player.play().catch(() => {}) // a reused player has no autoplay pass of its own
    loadTrackGain(path)
    setMediaMetadata(name)
    state.audioTrack = { path, name }
    // A song picked outside of paging starts its own run, so it is the newest by definition.
    if (!paging) state.audioHead = path
  } else if (type === "pdf") {
    body.innerHTML = `<iframe src="${esc(url)}" title="${esc(name)}"></iframe>`
  } else {
    const note = tooBigToEdit(name) ? "File too large for text editor" : "No preview available"
    body.innerHTML = `<div class="preview-none">${esc(note)}</div>`
  }
  const view = document.getElementById("preview-view")
  view.classList.toggle("has-embed", type === "pdf")
  // Only a photo takes the tap that toggles the chrome, so paging elsewhere must restore it.
  if (type !== "image") view.classList.remove("chrome-hidden")

  const media =
    type === "image" ? document.createElement("img") : body.querySelector("video, audio, iframe")
  if (media) {
    const placeholder = body.querySelector(".preview-placeholder")
    const spinner = document.createElement("div")
    spinner.className = "preview-spinner"
    body.appendChild(spinner)
    // Dropped in the same task the full image is appended, so only one of the two is ever painted.
    const loaded = () => {
      spinner.remove()
      placeholder?.remove()
    }
    const failed = () => {
      media.remove()
      placeholder?.remove()
      spinner.classList.add("failed")
      spinner.textContent = "Couldn't load this file"
    }
    if (media.tagName === "VIDEO" || media.tagName === "AUDIO") {
      // iOS may block autoplay and never fire loadeddata; metadata is enough to drop the spinner.
      for (const ev of ["loadedmetadata", "loadeddata", "playing"])
        media.addEventListener(ev, loaded, { once: true })
      media.addEventListener("error", failed, { once: true })
      // A bad/unsupported media source errors on the <source>, not the media element.
      media.querySelector("source")?.addEventListener("error", failed, { once: true })
    } else if (media.decode) {
      // iOS Safari paints big JPEGs dark until a tap forces recomposite; attach fully decoded.
      media.alt = name
      const attach = () => {
        if (!body.contains(spinner)) return
        body.appendChild(media)
        loaded()
        prefetchNeighborDisplays()
        if (displayUrl) upgradeToDisplay(media, displayUrl)
      }
      // decode() rejects some displayable images (huge JPEGs, SVGs); naturalWidth spots real failures.
      const load = (src, fallback) => {
        media.src = src
        media
          .decode()
          .then(attach, () =>
            media.naturalWidth ? attach() : fallback ? load(fallback, "") : failed()
          )
      }
      load(displayUrl || url, displayUrl && url)
    } else {
      media.addEventListener("load", loaded, { once: true })
      media.addEventListener("error", failed, { once: true })
      if (media.tagName === "IMG") {
        media.alt = name
        media.src = url
        body.appendChild(media)
      }
    }
  }

  // The back stack spans songs paged between; a song opened from the list starts a fresh one.
  if (!paging || type !== "audio") state.audioTrail = []
  state.previewType = type
  state.previewFiles = state.entries.filter((e) => !e.isDir && isViewable(e.name))
  state.previewIdx = state.previewFiles.findIndex((e) => e.name === name)
  state.previewEntry = entry || null
  renderPreviewBar(path, type)
  updatePreviewNav()
  updatePreviewTool(name)
  trimEntrylessPreviewOptions()
  if (type === "audio") warmNeighborGains()
}

// Rename and Delete need a listing row; Download and Details work from the path and the link.
const trimEntrylessPreviewOptions = () => {
  if (!sharedFile()) return
  const menu = document.getElementById("preview-options")
  for (const el of menu.querySelectorAll(".popover-item")) el.classList.add("hidden")
  for (const id of ["preview-download-btn", "preview-details-btn"])
    document.getElementById(id).classList.remove("hidden")
}

// Only the browser's dots refresh on a change: re-filtering here could drop the open file out.
const renderPreviewBar = (path, type) => {
  const bar = document.getElementById("preview-tagbar")
  const audio = type === "audio"
  bar.classList.toggle("has-audio", audio)
  bar.innerHTML = audio ? audioBarHtml() : ""
  const slot = document.getElementById("preview-tagslot")
  slot.innerHTML = state.share || state.inVault ? "" : tagEditorHtml(path, true)
  const editor = slot.querySelector(".tag-editor")
  // Retagging the open song can move it in or out of a filtered queue, moving the queue's ends.
  if (editor)
    wireTagEditor(editor, () => {
      renderFiles()
      updatePreviewNav()
    })
  if (audio) wireAudioBar()
}

const updatePreviewNav = () => {
  document.getElementById("preview-prev-btn").disabled = !previewNeighbor(-1)
  document.getElementById("preview-next-btn").disabled = !previewNeighbor(1)
}

const updatePreviewTool = (name) => {
  // Runs on every open, so it must re-apply what applyShareChrome hid rather than undo it.
  const owned = !state.share
  const btn = document.getElementById("preview-tool-btn")
  const tool = owned && canEdit() ? mediaToolFor(name) : null
  btn.classList.toggle("hidden", !tool)
  if (tool) document.getElementById("preview-tool-label").textContent = tool.label
  // A share link would hand out the plaintext the vault exists to keep in this tab.
  document.getElementById("preview-share-btn").classList.toggle("hidden", state.inVault || !owned)

  const level = document.getElementById("preview-level-btn")
  const audio = fileType(name) === "audio" && !state.share && !state.inVault && !VOLUME_LOCKED
  level.classList.toggle("hidden", !audio)
  level.classList.toggle("checked", state.audioNormalize)
  level.setAttribute("aria-checked", String(state.audioNormalize))
}

const openPreviewEntry = (entry, { paging = false } = {}) =>
  openPreview(relPath(entry.name), entry.name, fileType(entry.name), { replace: true, paging })

// Renaming to an extension the viewer can't show drops us back out to the listing.
const reopenRenamed = (name) => {
  const entry = state.entries.find((e) => e.name === name)
  if (entry && (isViewable(name) || previewsBlank(name))) openPreviewEntry(entry)
  else goBackToBrowser()
}

// Only an edit run from the viewer lands on its output; from the listing, refreshing is the job.
const openEditResult = async (name) => {
  await navigate(state.currentPath, { pushHash: false })
  if (document.getElementById("preview-view").classList.contains("hidden")) return
  const entry = state.entries.find((e) => e.name === name)
  if (entry && isViewable(name)) openPreview(relPath(name), name, fileType(name), { replace: true })
  else goBackToBrowser()
}

const previewNavigate = async (delta, { fromHead = null } = {}) => {
  const entry = previewNeighbor(delta)
  if (!entry) return
  // Stepping back asks for the neighbour again; it says nothing about the song being left.
  const back = delta < 0
  if (back) settleTagging(false, { keepOnly: true })
  // Only a step off the newest song extends the run; retracing from behind reads as no skip.
  const extend = !back && (fromHead ?? state.audioTrack?.path === state.audioHead)
  // The play queue holds the run's own history, so the trail only holds what it was paged in from.
  const from = currentPreviewEntry()?.name
  if (back) {
    if (state.audioTrail.at(-1) === entry.name) state.audioTrail.pop()
  } else if (from && fileType(from) !== "audio" && fileType(entry.name) === "audio")
    state.audioTrail.push(from)
  await openPreviewEntry(entry, { paging: true })
  if (extend && state.audioTrack) state.audioHead = state.audioTrack.path
}

const SWIPE_SLOP = 10 // movement before a touch counts as a drag rather than a tap
const SWIPE_MIN = 50 // drag distance that commits to paging
const SWIPE_MS = 150 // slide from wherever the finger left off to the settled position
const SWIPE_GAP = 24 // gutter between neighbors, so a swipe reads as two pictures, not one seam
const VIDEO_CONTROLS_H = 64 // bottom strip a native player's controls occupy

// A swipe or mouse drag pages photos and videos; a tap on a photo clears the chrome.
const setupPreviewSwipe = () => {
  const body = document.getElementById("preview-body")
  let start = null
  let dx = 0 // raw finger travel, before end-of-list damping
  let offset = 0 // translation actually applied to the body
  let gesture = 0 // bumped per touch, so a bounce settling late can't strip the next drag's peeks
  let dir = 0 // way the finger is currently travelling
  let peak = 0 // furthest dx that direction has reached

  const neighbor = (delta) => previewNeighbor(delta)
  const missing = (delta) => !neighbor(delta)

  // Doubling back overrides the drag's opening direction; past the slop, so jitter isn't a reversal.
  const steer = () => {
    if (!dir) dir = Math.sign(dx) || 1
    else if ((dx - peak) * dir < -SWIPE_SLOP) dir = -dir
    else if ((dx - peak) * dir <= 0) return
    peak = dx
  }

  // A song's peek holds a real player, and detaching one doesn't reliably drop its fetch.
  const clearPeeks = () =>
    body.querySelectorAll(".preview-peek").forEach((p) => {
      const el = p.querySelector("audio")
      if (el) {
        el.removeAttribute("src")
        el.load()
      }
      p.remove()
    })

  // A screen of travel plus the gutter: where the body must land for a neighbor to sit centred.
  const restPos = (delta) =>
    delta > 0
      ? `translateX(calc(-100% - ${SWIPE_GAP}px))`
      : `translateX(calc(100% + ${SWIPE_GAP}px))`

  // Unloaded until the drag is real, so a tap costs nothing.
  const peekHtml = (entry, type) => {
    const { thumb, original } = previewSrcs(entry, relPath(entry.name), entry.name, type)
    // A vault neighbour has neither until it is decrypted, which a drag is no reason to do.
    if (type === "audio")
      return original ? `<audio controls preload="none" src="${esc(original)}"></audio>` : ""
    return thumb ? `<img class="preview-placeholder" src="${esc(thumb)}" alt="">` : ""
  }

  // Thumbnails, from the same URLs the grid already loaded, so a drag reveals them without a fetch.
  const mountPeeks = () => {
    clearPeeks()
    for (const delta of [-1, 1]) {
      const entry = neighbor(delta)
      if (!entry) continue
      const html = peekHtml(entry, fileType(entry.name))
      if (!html) continue
      const pane = document.createElement("div")
      pane.className = "preview-peek"
      pane.dataset.delta = delta
      pane.style.transform = restPos(-delta)
      pane.innerHTML = html
      const standIn = pane.querySelector(".preview-placeholder")
      if (standIn) pinSmallStandIn(standIn)
      body.appendChild(pane)
    }
  }

  // Upgrades each thumb to the full image mid-drag, so the neighbour lands sharp, not blurry.
  const sharpenPeeks = () => {
    for (const pane of body.querySelectorAll(".preview-peek")) {
      const entry = neighbor(Number(pane.dataset.delta))
      if (!entry) continue
      const type = fileType(entry.name)
      // A song's peek fills its controls in, and warms the file the swipe is about to open.
      if (type === "audio") {
        const el = pane.querySelector("audio")
        if (el && el.preload !== "metadata") {
          el.preload = "metadata"
          el.load()
        }
        continue
      }
      if (type !== "image") continue
      const { original, display } = previewSrcs(entry, relPath(entry.name), entry.name, "image")
      const img = new Image()
      const swap = () => {
        // The gesture may have ended and cleared the peeks while this was in flight.
        if (pane.isConnected && img.naturalWidth) pane.replaceChildren(img)
      }
      img.src = display || original
      // decode() rejects some displayable images (huge JPEGs); naturalWidth spots real failures.
      img.decode().then(swap, swap)
    }
  }

  // Keyframed not transitioned, so timing sits beside the gesture. Cancelling rejects; ignore it.
  const slide = (from, to) =>
    body
      .animate([{ transform: from }, { transform: to }], { duration: SWIPE_MS, easing: "ease-out" })
      .finished.catch(() => {})

  // The inline transform is set to the end state up front, so nothing snaps back on finish.
  const settle = async (delta) => {
    if (!delta) {
      const token = gesture
      body.style.transform = ""
      await slide(`translateX(${offset}px)`, "translateX(0)")
      if (gesture === token) clearPeeks()
      return
    }
    state.previewSliding = true
    // Landing parks the peek dead centre, so the swap that follows repaints the same picture.
    const out = restPos(delta)
    body.style.transform = out
    await slide(`translateX(${offset}px)`, out)
    // Leaving the viewer mid-slide clears the flag; don't page back into a view we've closed.
    if (!state.previewSliding) return
    previewNavigate(delta) // rebuilds the body, dropping the peeks with it
    body.style.transform = ""
    state.previewSliding = false
  }

  body.addEventListener("pointerdown", (e) => {
    // A second finger means pinch/zoom, not a swipe.
    if (start) {
      start = null
      return
    }
    if (e.button !== 0) return
    if (state.previewSliding) return
    if (!["image", "video", "audio"].includes(state.previewType)) return
    // Dragging a player's controls scrubs it; that gesture is the player's, not ours.
    const player = body.querySelector(":scope > video, :scope > audio")
    if (player) {
      const r = player.getBoundingClientRect()
      // A video's controls are only its bottom strip; an audio element is nothing but controls.
      const top = player.tagName === "AUDIO" ? r.top : r.bottom - VIDEO_CONTROLS_H
      const x = e.clientX
      const y = e.clientY
      if (y > top && y < r.bottom && x > r.left && x < r.right) return
    }
    start = { x: e.clientX, y: e.clientY, at: Date.now(), touch: e.pointerType === "touch" }
    dx = offset = dir = peak = 0
    gesture++
    // A mouse dragged off the body would drop the gesture; touch is captured implicitly.
    if (!start.touch) {
      body.setPointerCapture(e.pointerId)
      // Otherwise the native image drag takes over and cancels the pointer stream.
      e.preventDefault()
    }
    // Mounted before the drag is confirmed, so thumbs are decoded by the first pixel of movement.
    mountPeeks()
  })

  body.addEventListener("pointermove", (e) => {
    if (!start) return
    dx = e.clientX - start.x
    const dy = e.clientY - start.y
    if (!start.drag) {
      if (Math.hypot(dx, dy) < SWIPE_SLOP) return
      // A mostly-vertical drag isn't ours; drop it rather than fight whatever owns it.
      if (Math.abs(dx) <= Math.abs(dy) * 1.5) {
        start = null
        clearPeeks()
        return
      }
      start.drag = true
      sharpenPeeks()
    }
    steer()
    // Damped past the ends of the list, so the resistance says there's nothing further.
    offset = missing(dx < 0 ? 1 : -1) ? dx / 4 : dx
    body.style.transform = `translateX(${offset}px)`
  })

  body.addEventListener("pointerup", (e) => {
    if (!start) return
    const { drag, at, touch } = start
    const dy = e.clientY - start.y
    start = null
    if (drag) {
      const delta = dir < 0 ? 1 : -1
      // Only the way the finger was last headed pages, and only from that far out its own side.
      const held = Math.sign(dx) === dir && Math.abs(dx) > SWIPE_MIN
      settle(held && !missing(delta) ? delta : 0)
      return
    }
    clearPeeks()
    // Click-to-hide would take the desktop chrome's own nav buttons with it, so it stays a tap.
    if (!touch) return
    if (Date.now() - at < 400 && Math.hypot(dx, dy) < SWIPE_SLOP && state.previewType === "image")
      document.getElementById("preview-view").classList.toggle("chrome-hidden")
  })

  body.addEventListener("pointercancel", () => {
    const drag = start?.drag
    start = null
    if (drag) settle(0)
    else clearPeeks()
  })
}

// ─── Audio playback ───────────────────────────────────────────────────────────

const AUDIO_MODE_LABEL = { off: "Autoplay off", sequential: "In order", shuffle: "Shuffle" }
// Only the off label names the control, so the two that don't lean on the aria to say what it is.
const audioModeAria = () =>
  state.audioMode === "off" ? "Autoplay off" : `Autoplay: ${AUDIO_MODE_LABEL[state.audioMode]}`
const AUDIO_MODE_NEXT = { off: "sequential", sequential: "shuffle", shuffle: "off" }
const TAG_KEEP_SECS = 15 // heard this much and the song earns the tag; skipped sooner, it loses it

// Direct child only: a swipe's peek mounts a player of its own, and that one is scenery.
const audioPlayer = () => document.querySelector("#preview-body > audio")

// Not the paging queue: an archive opens without joining it, and a tag filter can drop it out.
const currentPreviewEntry = () => state.previewEntry

// An empty result would strand playback, so a tag selection nothing matches falls back to all.
const audioQueue = () => {
  const songs = state.previewFiles.filter((e) => fileType(e.name) === "audio")
  if (!state.audioTags.size) return songs
  const kept = songs.filter((e) =>
    (state.fileTags[relPath(e.name)] || []).some((id) => state.audioTags.has(id))
  )
  return kept.length ? kept : songs
}

const queuePos = (queue) => {
  const cur = currentPreviewEntry()
  return cur ? queue.findIndex((e) => e.name === cur.name) : -1
}

// The songs a shuffled run has played, oldest first, plus the one it has settled on to follow.
let shuffleOrder = []

// The mix the tag being autotagged is set to, kept per tag so each pass remembers its own.
const audioMix = () => (state.audioTagging ? (state.audioMixes[state.audioTagging] ?? null) : null)

// A mix needs a tag to weigh against, and random picks to weigh; shuffle is turned on with it.
const mixShare = () => (audioMix() !== null && state.audioMode === "shuffle" ? audioMix() : null)

// One side of the mix: songs carrying the tag being autotagged, or the ones without it.
const mixSide = (songs, without) => {
  const has = (e) => (state.fileTags[relPath(e.name)] || []).includes(state.audioTagging)
  return songs.filter((e) => has(e) !== without)
}

// Narrows a pool to the side one roll of the share landed on; unweighted, every song stays in.
const mixRoll = (share) => {
  if (share === null) return (songs) => songs
  const without = Math.random() * 100 < share
  return (songs) => mixSide(songs, without)
}

// The first pool with anything in it, drawn from at random: the ones after it are the fallbacks.
const pickFrom = (...pools) => {
  const pool = pools.find((p) => p.length)
  return pool && pool[Math.floor(Math.random() * pool.length)]
}

// What the run plays next: a song it hasn't played yet, from the side the share rolled.
const dealForward = (queue, share) => {
  const cur = currentPreviewEntry()?.name
  const side = mixRoll(share)
  const fresh = side(queue.filter((e) => !shuffleOrder.includes(e.name)))
  if (fresh.length) return pickFrom(fresh)
  // A played-out side deals a fresh pass rather than defecting, which at 0 and 100 is the point.
  const rest = queue.filter((e) => e.name !== cur)
  shuffleOrder = queue.some((e) => e.name === cur) ? [cur] : []
  return pickFrom(side(rest), rest)
}

// A pick of its own, put in front, so back off the run's first song is random like the rest.
const dealBack = (queue, share) => {
  const cur = currentPreviewEntry()?.name
  const side = mixRoll(share)
  const rest = queue.filter((e) => e.name !== cur)
  const fresh = rest.filter((e) => !shuffleOrder.includes(e.name))
  // Nothing unplayed on the rolled side: it repeats rather than dead-ending, as forward re-deals.
  const prev = pickFrom(side(fresh), side(rest), fresh, rest)
  if (prev) shuffleOrder.unshift(prev.name)
  return prev
}

// A pick is committed as the order is read, so peek, skip button and ending song all agree.
const shuffledQueue = (queue, share) => {
  const cur = currentPreviewEntry()?.name
  const inQueue = (n) => queue.some((e) => e.name === n)
  // A song opened off the order — a new folder, or a pick from the list — starts a fresh one.
  if (cur && inQueue(cur) && !shuffleOrder.includes(cur)) shuffleOrder = [cur]
  shuffleOrder = shuffleOrder.filter(inQueue)
  const last = shuffleOrder.at(-1)
  if (!last || last === cur) {
    const next = dealForward(queue, share)
    if (next) shuffleOrder.push(next.name)
  }
  return shuffleOrder.map((n) => queue.find((e) => e.name === n))
}

// The queue in playback order: shuffle walks its own order, the rest the folder's.
const playQueue = (queue = audioQueue()) =>
  state.audioMode === "shuffle" ? shuffledQueue(queue, mixShare()) : queue

// What the run was paged into from — a photo it followed, which a queue of songs can't hold.
const trailBack = () => {
  while (state.audioTrail.length) {
    const entry = state.previewFiles.find((e) => e.name === state.audioTrail.at(-1))
    if (entry) return entry
    state.audioTrail.pop() // the file was renamed, moved or deleted out from under the stack
  }
}

// What paging lands on: a song steps through the play queue, anything else through the folder.
const previewNeighbor = (delta) => {
  // A file outside the paging queue (an archive) sits at -1, where +1 would land on the first.
  if (state.previewIdx < 0 && state.previewType !== "audio") return undefined
  if (state.previewType !== "audio") return state.previewFiles[state.previewIdx + delta]
  const songs = audioQueue()
  const order = playQueue(songs)
  const at = queuePos(order)
  // A tag filter can leave the open song outside its own queue; page in from the start.
  if (at < 0) return order[0]
  const step = order[at + delta]
  if (step) return step
  // Past its end the queue comes round again; only shuffle can run off the front of its order.
  if (delta > 0) return order[0]
  // Back off the head leaves the run for whatever it was paged into from; shuffle deals instead.
  const from = trailBack()
  if (from) return from
  if (state.audioMode === "shuffle") return dealBack(songs, mixShare()) || order.at(-1)
  return order.at(-1)
}

// Heard out, the song keeps the tag; skipped, it loses it. Returns whether a tag moved.
const settleTagging = (finished, { keepOnly = false } = {}) => {
  const track = state.audioTrack
  state.audioTrack = null
  const tag = tagById(state.audioTagging)
  if (!tag || !track || track.manual) return false
  const keep = finished || (audioPlayer()?.currentTime || 0) >= TAG_KEEP_SECS
  // Anything behind the head was chosen, not auditioned; keepOnly withholds the drop as well.
  if (!keep && (keepOnly || track.path !== state.audioHead)) return false
  if (keep === (state.fileTags[track.path] || []).includes(tag.id)) return false
  setFileTag(track.path, tag.id, keep)
  toast(`${keep ? "Tagged" : "Untagged"} “${track.name}” · ${tag.name}`, false, () => {
    setFileTag(track.path, tag.id, !keep)
    renderFiles()
    if (state.previewType !== "audio") return
    // The settled song can still be the one on screen; its tag bar carries the chips to revert.
    const entry = currentPreviewEntry()
    if (entry && relPath(entry.name) === track.path) renderPreviewBar(track.path, "audio")
    updatePreviewNav()
  })
  renderFiles()
  return true
}

// Lock screen, Control Center and headphone buttons: their skip keys do nothing without handlers.
const wireMediaSession = (player) => {
  const ms = navigator.mediaSession
  if (!ms) return
  const on = (action, fn) => {
    // Browsers throw on the actions they don't implement.
    try {
      ms.setActionHandler(action, fn)
    } catch {}
  }
  on("play", () => player.play())
  on("pause", () => player.pause())
  on("previoustrack", () => previewNavigate(-1))
  on("nexttrack", () => previewNavigate(1))
}

const setMediaMetadata = (name) => {
  const ms = navigator.mediaSession
  if (!ms || !window.MediaMetadata) return
  ms.metadata = new MediaMetadata({
    title: name.replace(/\.[^.]+$/, ""),
    album: state.currentPath.split("/").filter(Boolean).pop() || "",
  })
}

const clearMediaSession = () => {
  if (!navigator.mediaSession) return
  navigator.mediaSession.metadata = null
  navigator.mediaSession.playbackState = "none"
}

// ─── Loudness normalization ───────────────────────────────────────────────────

// The element's volume is this times the user's, so reading it back recovers their setting.
let trackGain = 1
let userVolume = cachedVolume >= 0 && cachedVolume <= 1 ? cachedVolume : 1
// Rises with every track change, so a measurement that arrives after a skip is discarded.
let gainToken = 0

const clamp01 = (v) => Math.min(1, Math.max(0, v))

// iOS reserves the level for the hardware buttons, so there is no levelling to be had there.
const VOLUME_LOCKED = (() => {
  const ua = navigator.userAgent
  // Newer WebKit keeps the value it was handed but still ignores it, so the probe can be fooled.
  const iOS = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  if (iOS) return true
  const probe = document.createElement("audio")
  probe.volume = 0.5
  return probe.volume !== 0.5
})()

// A vault song is measured nowhere: the server holds only its ciphertext.
const normalizeOn = () => state.audioNormalize && !state.share && !state.inVault && !VOLUME_LOCKED

const applyTrackGain = (gain) => {
  trackGain = gain
  const player = audioPlayer()
  if (player) player.volume = clamp01(userVolume * gain)
}

// A warmed gain lands before the song does; applied after the music starts it's an audible jump.
const gainCache = new Map()
// Warming and opening can reach for the same song at once; they share the one request.
const gainPending = new Map()

const fetchGain = (path) => {
  if (gainCache.has(path)) return Promise.resolve(gainCache.get(path))
  if (gainPending.has(path)) return gainPending.get(path)
  const pending = api("GET", "/api/files/loudness?path=" + encodeURIComponent(path))
    .then((res) => {
      const gain = typeof res.gain === "number" ? clamp01(res.gain) : 1
      gainCache.set(path, gain)
      return gain
    })
    .finally(() => gainPending.delete(path))
  gainPending.set(path, pending)
  return pending
}

// One file at a time: each measurement decodes a whole file server-side.
const gainQueue = []
let warming = false
// The measurement the song on screen waits on; warming stands aside for it.
let urgentGain = null

const runGainQueue = async () => {
  if (warming) return
  warming = true
  while (gainQueue.length) {
    if (urgentGain) await urgentGain
    const path = gainQueue.shift()
    if (!gainCache.has(path)) await fetchGain(path).catch(() => {})
  }
  warming = false
}

// `soon` is for the songs a skip away, which can't wait behind a folder's worth of warming.
const warmGains = (paths, { soon = false, only = false } = {}) => {
  if (!normalizeOn()) return
  if (only) gainQueue.length = 0 // a listing left behind is no longer worth measuring
  const want = [...new Set(paths)].filter((p) => p && !gainCache.has(p) && !gainPending.has(p))
  if (!soon) {
    gainQueue.push(...want.filter((p) => !gainQueue.includes(p)))
  } else {
    // Queued already, just too far back: pulled forward rather than passed over as a duplicate.
    for (const p of want) {
      const at = gainQueue.indexOf(p)
      if (at >= 0) gainQueue.splice(at, 1)
    }
    gainQueue.unshift(...want)
  }
  runGainQueue()
}

// Either way out of the open song is one skip away, so both neighbours are worth having ready.
const warmNeighborGains = () =>
  warmGains(
    [previewNeighbor(-1), previewNeighbor(1)]
      .filter((e) => e && fileType(e.name) === "audio")
      .map((e) => relPath(e.name)),
    { soon: true }
  )

// Audio in whatever is on screen, so opening any of it finds its level already measured.
const warmVisibleGains = (items, pathOf) =>
  warmGains(items.filter((i) => !i.isDir && fileType(i.name) === "audio").map(pathOf), {
    only: true,
  })

// A warmed song is levelled from its first note; one that isn't plays at the user's own level.
const loadTrackGain = async (path) => {
  const token = ++gainToken
  if (!normalizeOn()) {
    applyTrackGain(1)
    return
  }
  if (gainCache.has(path)) {
    applyTrackGain(gainCache.get(path))
    return
  }
  applyTrackGain(1)
  const pending = fetchGain(path)
  const mine = pending.catch(() => {})
  urgentGain = mine
  try {
    const gain = await pending
    if (token === gainToken) applyTrackGain(gain)
  } catch {
    if (token === gainToken) applyTrackGain(1)
  }
  if (urgentGain === mine) urgentGain = null
}

// One player serves every song: a fresh element loses the playback iOS unlocked on the first tap.
const buildAudioPlayer = () => {
  const player = document.createElement("audio")
  player.controls = true
  player.autoplay = true
  player.volume = clamp01(userVolume * trackGain)
  // Divide the gain back out, so the stored level is what the user chose rather than what plays.
  player.addEventListener("volumechange", () => {
    userVolume = clamp01(trackGain > 0 ? player.volume / trackGain : player.volume)
    localStorage.setItem("volume", userVolume)
  })
  const mark = (s) => navigator.mediaSession && (navigator.mediaSession.playbackState = s)
  player.addEventListener("play", () => mark("playing"))
  player.addEventListener("pause", () => mark("paused"))
  // iOS falls back to its own skip buttons unless the handlers are re-registered per src load.
  player.addEventListener("loadedmetadata", () => {
    wireMediaSession(player)
    const entry = state.previewType === "audio" && currentPreviewEntry()
    if (entry) setMediaMetadata(entry.name)
  })
  player.addEventListener("ended", () => {
    // Settling clears the track the run's position is read from, so take it before that.
    const fromHead = state.audioTrack?.path === state.audioHead
    const moved = settleTagging(true)
    if (state.audioMode !== "off") return previewNavigate(1, { fromHead })
    // A rebuild would close whatever menu the bar has open, so redraw only if the chips changed.
    const entry = currentPreviewEntry()
    if (moved && entry) renderPreviewBar(relPath(entry.name), "audio")
  })
  wireMediaSession(player)
  return player
}

const stopAudio = () => {
  const player = audioPlayer()
  if (player) {
    player.pause()
    player.removeAttribute("src")
    player.load() // aborts the in-flight media fetch too
  }
  clearMediaSession()
}

// Which tags is left to the dots, so the label only has to say whether the queue is narrowed.
const audioFilterBtnHtml = () => {
  const dots = state.tags
    .filter((t) => state.audioTags.has(t.id))
    .slice(0, 3)
    .map((t) => `<span class="tag-dot" style="--tag-color: ${esc(t.color)}"></span>`)
    .join("")
  const on = state.audioTags.size > 0
  return `${dots ? `<span class="tag-dots">${dots}</span>` : ""}
    <span>Play tags</span>`
}

// Both menus list the catalog; the filter ticks every chosen tag, tagging only the one running.
const audioMenuRows = (wrap) => {
  if (!state.tags.length) return `<p class="tag-menu-empty">No tags created yet.</p>`
  const filter = wrap.dataset.menu === "filter"
  return state.tags
    .map((t) => {
      const on = filter ? state.audioTags.has(t.id) : t.id === state.audioTagging
      return `
      <button type="button" class="tag-menu-item${on ? " active" : ""}"
        role="menuitemcheckbox" aria-checked="${on}" data-id="${esc(t.id)}">
        <span class="tag-dot" style="--tag-color: ${esc(t.color)}"></span>
        <span class="tag-menu-name">${esc(t.name)}</span>
        <svg class="tag-menu-check" aria-hidden="true"><use href="#icon-check" /></svg>
      </button>`
    })
    .join("")
}

// A blank field is the mix off; anything else is a whole percent within range.
const readMix = (raw) => {
  const n = Math.round(Number(raw.trim()))
  return raw.trim() && Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null
}

const MIX_PRESETS = [0, 10, 25, 100]

// Always in the menu so it never appears under the cursor; dead until a tag is picked to weigh.
const mixHtml = () => {
  const cur = audioMix()
  const off = state.audioTagging ? "" : " disabled"
  return `
  <div class="audio-mix${off}">
    <label class="audio-mix-row">
      <span>Untagged mix</span>
      <span class="audio-mix-field">
        <input type="number" inputmode="numeric" min="0" max="100" step="5" placeholder="Auto"
          value="${cur ?? ""}"${off} />
        <span aria-hidden="true">%</span>
      </span>
    </label>
    <div class="audio-mix-presets">
      ${MIX_PRESETS.map(
        (p) => `
      <button type="button" class="audio-mix-preset${cur === p ? " active" : ""}"
        data-mix="${p}"${off}>${p}%</button>`
      ).join("")}
    </div>
  </div>`
}

// The menus are filled on open, so a tag added from the row below shows up without a rebuild.
const audioBarHtml = () => {
  const tagging = tagById(state.audioTagging)
  return `
  <div class="audio-bar">
    <button type="button" class="audio-btn${state.audioMode === "off" ? "" : " active"}"
      id="audio-mode-btn" aria-label="${audioModeAria()}">
      <svg aria-hidden="true">
        <use href="#icon-${state.audioMode === "shuffle" ? "shuffle" : "repeat"}" />
      </svg>
      <span>${AUDIO_MODE_LABEL[state.audioMode]}</span>
    </button>
    ${
      state.share
        ? ""
        : `
    <div class="audio-menu-wrap" data-menu="filter">
      <button type="button" class="audio-btn${state.audioTags.size ? " active" : ""}"
        aria-haspopup="true">
        ${audioFilterBtnHtml()}
      </button>
      <div class="tag-menu audio-menu"><div class="tag-menu-list"></div></div>
    </div>
    <div class="audio-menu-wrap" data-menu="tagging">
      <button type="button" class="audio-btn${tagging ? " active" : ""}" aria-haspopup="true">
        ${tagging ? `<span class="tag-dot" style="--tag-color: ${esc(tagging.color)}"></span>` : ""}
        <span>Autotag</span>
      </button>
      <div class="tag-menu audio-menu">
        <p class="tag-menu-empty">
          Play past ${TAG_KEEP_SECS}s to add the tag, skip to drop it.
        </p>
        <div class="tag-menu-list"></div>
        ${mixHtml()}
      </div>
    </div>`
    }
  </div>`
}

const wireAudioBar = () => {
  const bar = document.querySelector(".preview-tagbar .audio-bar")
  if (!bar) return
  const wraps = [...bar.querySelectorAll(".audio-menu-wrap")]
  const closeMenus = () => wraps.forEach((w) => w.classList.remove("menu-open"))
  const fill = (wrap) => (wrap.querySelector(".tag-menu-list").innerHTML = audioMenuRows(wrap))

  // Switching modes redraws both buttons, so the menu picked from is named to be reopened after.
  const rebuild = (keepMenu) => {
    const entry = currentPreviewEntry()
    renderPreviewBar(entry ? relPath(entry.name) : "", "audio")
    const kept = keepMenu && document.querySelector(`.audio-menu-wrap[data-menu="${keepMenu}"]`)
    if (!kept) return
    fill(kept)
    kept.classList.add("menu-open")
  }

  bar.addEventListener("click", (e) => {
    const btn = e.target.closest(".audio-btn")
    if (btn) {
      const wrap = btn.closest(".audio-menu-wrap")
      if (!wrap) {
        state.audioMode = AUDIO_MODE_NEXT[state.audioMode]
        shuffleOrder = [] // each turn at shuffle deals a new order, starting from the open song
        savePrefs()
        rebuild()
        updatePreviewNav() // the reordered queue moves the ends, so the skip buttons follow
        return
      }
      const open = !wrap.classList.contains("menu-open")
      closeMenus()
      if (!open) return
      fill(wrap)
      wrap.classList.add("menu-open")
      return
    }
    const item = e.target.closest(".tag-menu-item")
    if (!item) return
    const wrap = item.closest(".audio-menu-wrap")
    const id = item.dataset.id
    // The filter is multi-select, so it repaints in place rather than closing over the next pick.
    if (wrap.dataset.menu === "filter") {
      if (state.audioTags.has(id)) state.audioTags.delete(id)
      else state.audioTags.add(id)
      // Playing tags and autotagging are modes, not a combination: one narrows, the other rewrites.
      if (state.audioTagging && state.audioTags.size) {
        state.audioTagging = null
        shuffleOrder = []
        rebuild("filter")
        updatePreviewNav()
        return
      }
      const opener = wrap.querySelector(".audio-btn")
      opener.innerHTML = audioFilterBtnHtml()
      opener.classList.toggle("active", state.audioTags.size > 0)
      fill(wrap)
      updatePreviewNav()
      return
    }
    // Picking the tag already running stops the pass; the song in flight keeps its verdict.
    state.audioTagging = id === state.audioTagging ? null : id
    if (state.audioTagging) state.audioTags.clear() // only one of the two modes narrows playback
    shuffleOrder = [] // the queue and the mix both move under the new tag, so the trail re-deals
    rebuild("tagging") // the pick is what makes the mix live, so the menu stays put to reach it
    updatePreviewNav()
  })

  // Repainted in place rather than through a rebuild, which would close the menu being typed in.
  const syncModeBtn = () => {
    const btn = bar.querySelector("#audio-mode-btn")
    const icon = state.audioMode === "shuffle" ? "shuffle" : "repeat"
    btn.classList.toggle("active", state.audioMode !== "off")
    btn.setAttribute("aria-label", audioModeAria())
    btn.querySelector("use").setAttribute("href", `#icon-${icon}`)
    btn.querySelector("span").textContent = AUDIO_MODE_LABEL[state.audioMode]
  }

  const mixWrap = bar.querySelector(".audio-mix")
  const mix = mixWrap?.querySelector("input")
  if (mix) {
    const applyMix = (share) => {
      if (!state.audioTagging) return
      if (share === null) delete state.audioMixes[state.audioTagging]
      else state.audioMixes[state.audioTagging] = share
      // A share can only decide between random picks, so entering one turns shuffle on to make them.
      if (share !== null && state.audioMode !== "shuffle") {
        state.audioMode = "shuffle"
        syncModeBtn()
      }
      savePrefs()
      shuffleOrder = [] // the trail re-deals from the open song, under the new share
      mixWrap
        .querySelectorAll(".audio-mix-preset")
        .forEach((b) => b.classList.toggle("active", Number(b.dataset.mix) === share))
      updatePreviewNav()
    }

    mix.addEventListener("input", () => applyMix(readMix(mix.value)))
    // Half-typed and out-of-range entries are only tidied once the field is left alone.
    mix.addEventListener("change", () => (mix.value = audioMix() ?? ""))
    // The viewer's arrow keys would otherwise page the song out from under the field.
    mix.addEventListener("keydown", (e) => e.stopPropagation())

    // Picking the share already set clears it, the one quick way back to an unweighted shuffle.
    mixWrap.addEventListener("click", (e) => {
      const preset = e.target.closest(".audio-mix-preset")
      if (!preset) return
      const share = Number(preset.dataset.mix) === audioMix() ? null : Number(preset.dataset.mix)
      mix.value = share ?? ""
      applyMix(share)
    })
  }

  // Self-removing: every rerender of the bar drops the element this was wired to.
  const onDocClick = (e) => {
    if (!bar.isConnected) document.removeEventListener("click", onDocClick, true)
    else if (!bar.contains(e.target)) closeMenus()
  }
  document.addEventListener("click", onDocClick, true)
}

// ─── Background jobs ──────────────────────────────────────────────────────────

// Polled only while something is outstanding; the panel is what says whether that's the case.
let jobPollTimer = null
let lastJobs = []
// The one conversion the user asked for by hand, so only its output is worth opening on its own.
let jobToOpen = null
// The job the panel is reporting on, kept past its end so the outcome gets a moment on screen.
let jobPanelId = null
let jobPanelTimer = null

const jobActive = (j) => j.status === "queued" || j.status === "running"

const pollJobs = async () => {
  try {
    const res = await api("GET", "/api/jobs")
    const finished = lastJobs.filter(jobActive).map((j) => j.id)
    lastJobs = res.jobs || []
    // The panel reports the finish itself; only the reason a job failed needs saying out loud.
    for (const j of lastJobs) {
      if (!finished.includes(j.id) || jobActive(j)) continue
      if (j.status === "failed") {
        toast(`“${j.name}”: ${j.error || "conversion failed"}`, true)
        continue
      }
      if (j.status !== "done") continue
      // Only act when the new file belongs in the folder on screen, and never over an open dialog.
      const landedHere = j.output && dirName(j.output) === state.currentPath
      const browsing = !document.getElementById("browser-view").classList.contains("hidden")
      const previewing = !document.getElementById("preview-view").classList.contains("hidden")
      const busy = document.getElementById("modal-backdrop").classList.contains("active")
      if (!landedHere || busy) continue
      const source = baseName(j.path)
      // The file it came from is the one selection that doesn't mean the user has moved on.
      const idle = !state.selected.size || (state.selected.size === 1 && state.selected.has(source))
      const onSource = previewing && currentPreviewEntry()?.name === source
      // Only a conversion started from the viewer lands on its output; from the listing it refreshes.
      if (j.id === jobToOpen && idle && onSource) {
        jobToOpen = null
        openEditResult(baseName(j.output))
      } else if (browsing && !state.selected.size) {
        // A background finish must not redraw a listing the user is selecting in.
        navigate(state.currentPath, { pushHash: false })
      }
    }
  } catch {
    lastJobs = []
  }
  renderJobPanel()
  clearTimeout(jobPollTimer)
  if (lastJobs.some(jobActive)) jobPollTimer = setTimeout(pollJobs, 1500)
}

const startJobPolling = () => {
  clearTimeout(jobPollTimer)
  pollJobs()
}

// Only one conversion runs at a time, so the panel follows that one and counts the rest.
const jobPanelEls = () => ({
  panel: document.getElementById("jobs-progress"),
  title: document.getElementById("jobs-progress-title"),
  bar: document.getElementById("jobs-bar-fill"),
  label: document.getElementById("jobs-label"),
  cancel: document.getElementById("jobs-cancel"),
})

const jobOutcomeLabel = (j) => {
  if (j.status === "failed") return "Failed"
  if (j.status === "canceled") return "Canceled"
  if (!j.inSize || !j.outSize) return "Done"
  // A low-bitrate source can come out bigger; say so rather than implying every run saves space.
  const grew = j.outSize > j.inSize
  return `Done · ${fmtSize(j.inSize)} → ${fmtSize(j.outSize)}${grew ? " (larger)" : ""}`
}

const renderJobPanel = () => {
  const { panel, title, bar, label, cancel } = jobPanelEls()
  if (!panel) return
  const active = lastJobs.filter(jobActive)
  const current = active.find((j) => j.status === "running") || active[0]

  if (current) {
    clearTimeout(jobPanelTimer)
    jobPanelTimer = null
    jobPanelId = current.id
    const pct = Math.round((current.progress || 0) * 100)
    const waiting = active.length - 1
    const running = current.status === "running"
    title.textContent = `${running ? "Downsizing" : "Waiting to downsize"} “${current.name}”`
    bar.style.width = running ? `${pct}%` : "0%"
    label.textContent = (running ? `${pct}%` : "Queued") + (waiting ? ` · ${waiting} queued` : "")
    cancel.classList.remove("hidden")
    cancel.dataset.id = current.id
    panel.classList.add("active")
    return
  }

  // Nothing left to run: let the outcome sit for a moment before the panel goes.
  if (!jobPanelId || jobPanelTimer) return
  const ended = lastJobs.find((j) => j.id === jobPanelId)
  jobPanelId = null
  cancel.classList.add("hidden")
  if (!ended) {
    panel.classList.remove("active")
    return
  }
  // A job can fail before a poll ever caught it running, and "Waiting to…, Failed" reads wrong.
  title.textContent = `Downsizing “${ended.name}”`
  if (ended.status === "done") bar.style.width = "100%"
  label.textContent = jobOutcomeLabel(ended)
  jobPanelTimer = setTimeout(() => {
    jobPanelTimer = null
    panel.classList.remove("active")
    bar.style.width = "0%"
  }, 2500)
}

// ─── Media tools ──────────────────────────────────────────────────────────────

// "M:SS.d" — tenths matter here because a trim point is chosen by ear against the playhead.
const fmtTrimTime = (secs) => {
  const s = Math.max(0, secs || 0)
  const m = Math.floor(s / 60)
  const rest = (s % 60).toFixed(1).padStart(4, "0")
  return `${m}:${rest}`
}

// Accepts "M:SS.d" or bare seconds; null when it reads as neither.
const parseTrimTime = (raw) => {
  const text = String(raw).trim()
  if (!text) return null
  const parts = text.split(":")
  if (parts.length > 2 || parts.some((p) => p !== "" && isNaN(Number(p)))) return null
  const secs =
    parts.length === 2 ? Number(parts[0] || 0) * 60 + Number(parts[1] || 0) : Number(parts[0])
  return Number.isFinite(secs) && secs >= 0 ? secs : null
}

const replaceRowHtml = (label) => `
  <label class="tool-check">
    <input type="checkbox" class="tool-replace" />
    <span>${esc(label)}</span>
  </label>`

// Parks the playhead this far before a moved end mark, so play auditions the cutoff, not silence.
const TRIM_TAIL_PREVIEW = 3

const showTrimAudio = (path, name) => {
  const page = audioPlayer()
  // Its own element: sharing the viewer's player let page playback drive this dialog.
  const audio = new Audio()
  audio.preload = "metadata"
  audio.volume = clamp01(userVolume * trackGain)
  audio.src = previewSrcs(currentPreviewEntry(), path, name, "audio").original
  page?.pause()

  // Same file, so its length is worth borrowing: the end mark is right on the first frame.
  let duration = page && isFinite(page.duration) ? page.duration : 0
  let start = 0
  let end = duration
  let cursor = 0
  let raf = null
  let dragging = null

  const closeModal = showExtraModal({
    title: `Trim “${name}”`,
    okLabel: "Trim",
    extraHtml: `
      <div class="tool-form">
        <div class="trim-player">
          <button type="button" class="trim-play" id="trim-play" aria-label="Play selection">
            <svg aria-hidden="true"><use href="#icon-play" /></svg>
          </button>
          <div class="trim-scrub" id="trim-scrub">
            <div class="trim-track">
              <div class="trim-sel" id="trim-sel"></div>
              <div class="trim-playhead" id="trim-playhead"></div>
              <div class="trim-handle" id="trim-handle-start" data-mark="start"
                role="slider" tabindex="0" aria-label="Start"></div>
              <div class="trim-handle" id="trim-handle-end" data-mark="end"
                role="slider" tabindex="0" aria-label="End"></div>
            </div>
          </div>
          <span class="trim-clock" id="trim-clock">0:00.0</span>
        </div>
        <div class="trim-marks">
          <label class="trim-mark">
            <span>Start</span>
            <input type="text" class="trim-start" inputmode="decimal" value="0:00.0" />
          </label>
          <label class="trim-mark">
            <span>End</span>
            <input type="text" class="trim-end" inputmode="decimal"
              value="${esc(fmtTrimTime(duration))}" />
          </label>
          <span class="trim-length" id="trim-length"></span>
        </div>
        ${replaceRowHtml("Replace the original instead of saving a copy")}
      </div>`,
    onOk: async () => {
      const replace = extra.querySelector(".tool-replace").checked
      if (end - start < 0.1) {
        toast("That selection is too short", true)
        return
      }
      okBtn.disabled = true
      okBtn.textContent = "Trimming…"
      try {
        const res = await api("POST", "/api/media/trim-audio", { path, start, end, replace })
        dismiss()
        toast(`Saved “${res.name}”`)
        await openEditResult(res.name)
      } catch (e) {
        toast(e.message, true)
        okBtn.disabled = false
        okBtn.textContent = "Trim"
      }
    },
  })

  const extra = document.getElementById("modal-extra")
  const okBtn = document.getElementById("modal-ok")
  const startInp = extra.querySelector(".trim-start")
  const endInp = extra.querySelector(".trim-end")
  const lengthEl = extra.querySelector("#trim-length")
  const scrub = extra.querySelector("#trim-scrub")
  const sel = extra.querySelector("#trim-sel")
  const head = extra.querySelector("#trim-playhead")
  const clock = extra.querySelector("#trim-clock")
  const playBtn = extra.querySelector("#trim-play")
  const handles = {
    start: extra.querySelector("#trim-handle-start"),
    end: extra.querySelector("#trim-handle-end"),
  }

  const pct = (t) => (duration > 0 ? Math.min(100, Math.max(0, (t / duration) * 100)) : 0)

  const paint = () => {
    sel.style.left = pct(start) + "%"
    sel.style.width = Math.max(0, pct(end) - pct(start)) + "%"
    handles.start.style.left = pct(start) + "%"
    handles.end.style.left = pct(end) + "%"
    for (const [mark, el] of Object.entries(handles)) {
      const at = mark === "start" ? start : end
      el.setAttribute("aria-valuetext", fmtTrimTime(at))
    }
    head.style.left = pct(cursor) + "%"
    clock.textContent = fmtTrimTime(cursor)
  }

  const syncLength = () => {
    // No duration yet from the listing: an empty span is loading, not a bad selection.
    const pending = duration <= 0
    const ok = end > start
    lengthEl.textContent = pending
      ? ""
      : ok
        ? `Keeping ${fmtTrimTime(end - start)}`
        : "The end must come after the start"
    lengthEl.classList.toggle("invalid", !pending && !ok)
    okBtn.disabled = pending || !ok
    paint()
  }

  // The playhead stays inside the selection; what's outside it is about to be cut.
  const seek = (t) => {
    const top = Math.max(start, end) // an inverted span is a half-typed one; don't fight it
    cursor = Math.min(top, Math.max(start, t))
    audio.currentTime = cursor
    paint()
  }

  const setMark = (mark, at, { park = true } = {}) => {
    const t = Math.min(duration, Math.max(0, at))
    if (mark === "start") {
      start = t
      startInp.value = fmtTrimTime(t)
    } else {
      end = t
      endInp.value = fmtTrimTime(t)
    }
    syncLength()
    // A moved mark takes the playhead with it, so play auditions the edge just placed.
    if (park) seek(mark === "start" ? start : end - TRIM_TAIL_PREVIEW)
    else seek(cursor)
  }

  // Read from the element: a play() the browser refuses must not leave a pause icon over silence.
  const syncPlayIcon = () => {
    playBtn.classList.toggle("playing", !audio.paused)
    playBtn.querySelector("use").setAttribute("href", audio.paused ? "#icon-play" : "#icon-pause")
    playBtn.setAttribute("aria-label", audio.paused ? "Play selection" : "Pause")
  }

  // The playhead runs off rAF rather than timeupdate, which only fires about four times a second.
  const follow = () => {
    if (audio.currentTime >= end) {
      audio.pause()
      cursor = end
      paint()
    } else {
      cursor = audio.currentTime
      head.style.left = pct(cursor) + "%"
      clock.textContent = fmtTrimTime(cursor)
    }
    syncPlayIcon()
    // Idles when the audio stops, so an open dialog doesn't hold a frame callback forever.
    raf = audio.paused ? null : requestAnimationFrame(follow)
  }

  const pausePlayback = () => {
    cancelAnimationFrame(raf)
    raf = null
    audio.pause()
    syncPlayIcon()
  }

  const togglePlay = () => {
    if (!audio.paused) return pausePlayback()
    if (cursor >= end - 0.05) seek(start) // ran to the cutoff already; a replay starts over
    audio.play().then(syncPlayIcon, syncPlayIcon)
    if (!raf) raf = requestAnimationFrame(follow)
  }

  playBtn.addEventListener("click", togglePlay)

  const timeAt = (clientX) => {
    const box = scrub.getBoundingClientRect()
    return ((clientX - box.left) / box.width) * duration
  }

  // Dragging a handle moves its mark; dragging anywhere else on the bar seeks.
  scrub.addEventListener("pointerdown", (e) => {
    if (!duration) return
    // Or the browser runs off dragging a ghost of whatever is under the cursor instead.
    e.preventDefault()
    const handle = e.target.closest(".trim-handle")
    dragging = handle ? handle.dataset.mark : "seek"
    if (handle) {
      handle.focus() // claiming the pointerdown above skipped the focus the click would have given
      pausePlayback() // a drag reseeks on every move, which would machine-gun the decoder
    }
    scrub.setPointerCapture(e.pointerId)
    onDragMove(e)
  })

  const onDragMove = (e) => {
    if (!dragging) return
    const t = timeAt(e.clientX)
    if (dragging === "seek") return seek(t)
    // Marks can't cross: each stops a hair short of the other so the span never inverts.
    if (dragging === "start") setMark("start", Math.min(t, end - 0.1))
    else setMark("end", Math.max(t, start + 0.1))
  }

  scrub.addEventListener("pointermove", onDragMove)
  const endDrag = () => (dragging = null)
  scrub.addEventListener("pointerup", endDrag)
  scrub.addEventListener("pointercancel", endDrag)

  // Arrow keys nudge a focused handle, which is the only way to place one precisely by keyboard.
  for (const [mark, el] of Object.entries(handles)) {
    el.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 1 : 0.1
      if (e.key === "ArrowLeft") setMark(mark, (mark === "start" ? start : end) - step)
      else if (e.key === "ArrowRight") setMark(mark, (mark === "start" ? start : end) + step)
      else return
      e.preventDefault()
      e.stopPropagation()
    })
  }

  // Typed marks aren't written back to the field being edited, which would fight the caret.
  const readMarks = (mark) => {
    const s = parseTrimTime(startInp.value)
    const e = parseTrimTime(endInp.value)
    const typed = mark === "start" ? s : e
    if (s !== null) start = Math.min(s, duration)
    if (e !== null) end = Math.min(e, duration)
    syncLength()
    // Typing a mark parks the playhead on it, the same as dragging its handle does.
    if (typed === null) return seek(cursor)
    pausePlayback() // every keystroke reseeks, which mid-playback machine-guns the decoder
    seek(mark === "start" ? start : end - TRIM_TAIL_PREVIEW)
  }

  startInp.addEventListener("input", () => readMarks("start"))
  endInp.addEventListener("input", () => readMarks("end"))
  // The viewer pages songs on arrow keys, which would swap the file out from under the dialog.
  for (const el of [startInp, endInp]) el.addEventListener("keydown", (ev) => ev.stopPropagation())

  // Closing has to silence a detached element nothing else holds a handle to.
  const dismiss = () => {
    pausePlayback()
    audio.removeAttribute("src")
    audio.load() // aborts the in-flight media fetch too
    closeModal()
  }
  const backdrop = document.getElementById("modal-backdrop")
  document.getElementById("modal-cancel").onclick = dismiss
  // Esc reaches here as a synthetic call carrying only a target, so match on that alone.
  backdrop.onclick = (e) => {
    if (e.target === backdrop) dismiss()
  }
  // Dropping the shell's Enter shortcut: it would trim off an Enter meant for the play button.
  extra.onkeydown = null

  // The end mark can only be placed once the file's own metadata says how long it is.
  audio.addEventListener("loadedmetadata", () => {
    if (!isFinite(audio.duration)) return
    const untouched = end >= duration
    duration = audio.duration
    if (untouched) setMark("end", duration, { park: false })
    else syncLength()
  })

  syncLength()
  seek(0) // the start of the file, not wherever the viewer's player happened to be
}

const IMAGE_SIZE_PRESETS = [1280, 1920, 2560, 4096]

const showResizeImages = (items) => {
  const many = items.length > 1
  const cleanup = showExtraModal({
    title: many ? `Resize ${items.length} images` : `Resize “${items[0].name}”`,
    okLabel: "Resize",
    extraHtml: `
      <div class="tool-form">
        <label class="tool-row">
          <span>Longest side</span>
          <select class="tool-select" id="img-size">
            ${IMAGE_SIZE_PRESETS.map(
              (p) => `<option value="${p}"${p === 1920 ? " selected" : ""}>${p} px</option>`
            ).join("")}
          </select>
        </label>
        <label class="tool-row">
          <span>Quality</span>
          <input type="range" id="img-quality" min="40" max="95" step="5" value="80" />
          <output for="img-quality" id="img-quality-out">80</output>
        </label>
        ${replaceRowHtml("Replace the original instead of saving a copy")}
      </div>`,
    onOk: async () => {
      okBtn.disabled = true
      const opts = {
        maxDim: Number(extra.querySelector("#img-size").value),
        quality: Number(extra.querySelector("#img-quality").value),
        replace: extra.querySelector(".tool-replace").checked,
      }
      // A file that can't be resized is skipped rather than abandoning the rest of the batch.
      const done = []
      let failure = null
      for (const [i, item] of items.entries()) {
        okBtn.textContent = many ? `Resizing ${i + 1}/${items.length}…` : "Resizing…"
        try {
          done.push(await api("POST", "/api/media/resize-image", { path: item.path, ...opts }))
        } catch (e) {
          failure = e
        }
      }
      // Nothing landed, so the dialog stays up: its settings are what there is to change.
      if (!done.length) {
        toast(failure.message, true)
        okBtn.disabled = false
        okBtn.textContent = "Resize"
        return
      }
      cleanup()
      const was = done.reduce((n, r) => n + r.wasSize, 0)
      const size = done.reduce((n, r) => n + r.size, 0)
      const skipped = items.length - done.length
      const what = many ? `Resized ${done.length} images` : `Saved “${done[0].name}”`
      toast(`${what} — ${fmtSize(was)} → ${fmtSize(size)}${skipped ? `, ${skipped} skipped` : ""}`)
      // A batch has no single result to land on, so it goes back to the listing holding them all.
      if (done.length === 1) return openEditResult(done[0].name)
      await navigate(state.currentPath, { pushHash: false })
      showBrowser()
    },
  })

  const extra = document.getElementById("modal-extra")
  const okBtn = document.getElementById("modal-ok")
  const quality = extra.querySelector("#img-quality")
  quality.addEventListener("input", () => {
    extra.querySelector("#img-quality-out").textContent = quality.value
  })
}

// x264 rate factors, sent as-is: lower is better, and 23 is x264's own default.
const VIDEO_QUALITIES = [
  { crf: 20, label: "Higher quality" },
  { crf: 23, label: "Balanced" },
  { crf: 26, label: "Smaller file" },
]

const showResizeVideo = (path, name) => {
  const cleanup = showExtraModal({
    title: `Resize “${name}”`,
    okLabel: "Start",
    extraHtml: `
      <div class="tool-form">
        <label class="tool-row">
          <span>Resolution</span>
          <select class="tool-select" id="vid-preset">
            <option value="720p">720p</option>
            <option value="1080p" selected>1080p</option>
            <option value="1440p">1440p</option>
          </select>
        </label>
        <label class="tool-row">
          <span>Quality</span>
          <select class="tool-select" id="vid-crf">
            ${VIDEO_QUALITIES.map(
              (q) =>
                `<option value="${q.crf}"${q.crf === 23 ? " selected" : ""}>${q.label}</option>`
            ).join("")}
          </select>
        </label>
        <p class="tool-note">
          This runs in the background and can take a while; you can keep browsing.
        </p>
        ${replaceRowHtml("Replace the original instead of saving a copy")}
      </div>`,
    onOk: async () => {
      okBtn.disabled = true
      try {
        const res = await api("POST", "/api/media/resize-video", {
          path,
          preset: extra.querySelector("#vid-preset").value,
          crf: Number(extra.querySelector("#vid-crf").value),
          replace: extra.querySelector(".tool-replace").checked,
        })
        jobToOpen = res.id
        cleanup()
        startJobPolling()
      } catch (e) {
        toast(e.message, true)
        okBtn.disabled = false
      }
    },
  })

  const extra = document.getElementById("modal-extra")
  const okBtn = document.getElementById("modal-ok")
}

// RAW and SVG both decode to something the JPEG re-encode would quietly ruin.
const isResizableImage = (name) =>
  fileType(name) === "image" && !isRaw(name) && extOf(name) !== "svg"

// Mounted objects are excluded: editing one would mean pulling it down and pushing it back.
const mediaToolFor = (name) => {
  // A vault's files are ciphertext to ffmpeg, and handing it the plaintext would defeat the vault.
  if (state.inMount || state.share || state.inVault) return null
  const type = fileType(name)
  if (type === "audio") return { label: "Trim audio", open: showTrimAudio }
  if (isResizableImage(name))
    return { label: "Resize image", open: (path, n) => showResizeImages([{ path, name: n }]) }
  if (type === "video") return { label: "Resize video", open: showResizeVideo }
  return null
}

// Resizing is the only tool that takes a batch; the rest need a single file.
const selectionTool = (entries) => {
  if (!entries.length || entries.some((e) => e.isDir)) return null
  if (
    entries.every((e) => isResizableImage(e.name)) &&
    !state.inMount &&
    !state.share &&
    !state.inVault
  )
    return {
      label: entries.length === 1 ? "Resize image" : `Resize ${entries.length} images`,
      open: () => showResizeImages(entries.map((e) => ({ path: relPath(e.name), name: e.name }))),
    }
  if (entries.length !== 1) return null
  const [entry] = entries
  const tool = mediaToolFor(entry.name)
  return tool && { label: tool.label, open: () => tool.open(relPath(entry.name), entry.name) }
}

// ─── Vault ────────────────────────────────────────────────────────────────────

// Plaintext lives only in this tab: the server holds age ciphertext and never sees the passphrase.
// The index becomes an ordinary listing and the blobs blob: URLs, so the usual views work.

const VAULT_MIN_PASSPHRASE = 12

// Marks a thumbnail whose bytes come from the index rather than a URL the browser could fetch.
const VAULT_SRC = "vault:"

// A blob carries no filename, so the type recorded at upload is what makes it render.
const VAULT_FALLBACK_MIME = {
  image: "image/*",
  video: "video/*",
  audio: "audio/*",
  pdf: "application/pdf",
}

// Revoked on lock and on the way out, so plaintext never outlives the folder it came from.
const vaultBlobs = new Map() // id -> blob: URL
const vaultPending = new Map() // id -> in-flight decryption, so a thumb and a preview share one
let vaultGen = 0 // bumped on release; a decryption that lands after it has nothing left to belong to

const releaseVaultBlob = (id) => {
  const url = vaultBlobs.get(id)
  if (!url) return
  URL.revokeObjectURL(url)
  vaultBlobs.delete(id)
}

const releaseVaultBlobs = () => {
  vaultGen++
  for (const url of vaultBlobs.values()) URL.revokeObjectURL(url)
  vaultBlobs.clear()
  vaultPending.clear()
}

const vaultBlobUrl = (id) => {
  const held = vaultBlobs.get(id)
  if (held) return Promise.resolve(held)
  let pending = vaultPending.get(id)
  if (!pending) {
    const gen = vaultGen
    pending = Vault.readFile(id).then(({ name, bytes, mime }) => {
      const type = mime || VAULT_FALLBACK_MIME[fileType(name)] || "application/octet-stream"
      const url = URL.createObjectURL(new Blob([bytes], { type }))
      if (gen !== vaultGen) {
        URL.revokeObjectURL(url)
        throw new Error("Vault locked")
      }
      vaultBlobs.set(id, url)
      vaultPending.delete(id)
      return url
    })
    vaultPending.set(id, pending)
  }
  return pending
}

const vaultUnlocked = () => state.inVault && Vault.openPath() === state.vaultRoot

// A path as the index knows it: "/" is the vault's own folder, "/Photos" a folder inside it.
const vaultSubOf = (path) => {
  const root = Vault.openPath() || state.vaultRoot
  if (!root || path === root) return "/"
  return "/" + path.slice(root.length + 1)
}

const vaultSub = () => vaultSubOf(state.currentPath)

// Locking drops every decrypted view, so it leaves the browser at the vault's own folder — the
// one path inside it the server can still list.
const lockVault = (message) => {
  Vault.lock()
  releaseVaultBlobs()
  state.allEntries = []
  applyEntryFilters()
  showBrowser({ pushHash: false })
  state.currentPath = state.vaultRoot || state.currentPath
  replacePathHash(state.currentPath)
  clearSelection()
  renderBreadcrumb()
  updateVaultToggle()
  renderFiles()
  if (message) toast(message)
}

const onVaultAutoLock = () => {
  if (!state.inVault) return
  lockVault("Vault locked after inactivity")
}

const renderVaultLocked = (container) => {
  const panel = document.createElement("div")
  panel.className = "vault-locked"
  panel.innerHTML = `
    <div class="icon">🔒</div>
    <p class="vault-locked-title">This folder is encrypted</p>
    <form class="vault-unlock-form" autocomplete="off">
      <input type="password" id="vault-pass" placeholder="Password or recovery code"
             autocomplete="current-password" />
      <button class="btn btn-primary btn-lg" type="submit">Unlock</button>
    </form>
    <p class="vault-error hidden" id="vault-error"></p>`
  container.replaceChildren(panel)

  const input = panel.querySelector("#vault-pass")
  const err = panel.querySelector("#vault-error")
  input.focus()
  panel.querySelector("form").addEventListener("submit", async (e) => {
    e.preventDefault()
    const secret = input.value
    if (!secret) return
    const submit = panel.querySelector("button[type=submit]")
    submit.disabled = true
    submit.textContent = "Unlocking…"
    err.classList.add("hidden")
    try {
      await Vault.unlock(state.vaultRoot, secret)
      input.value = ""
      // A deep link that couldn't be followed while sealed resumes here, now that it can be.
      const target = state.pendingVaultPath || state.currentPath
      state.pendingVaultPath = null
      await navigate(target, { pushHash: false })
    } catch (ex) {
      err.textContent = ex.message
      err.classList.remove("hidden")
      submit.disabled = false
      submit.textContent = "Unlock"
      input.select()
    }
  })
}

const showVaultCreate = () => {
  showModal({
    title: "New vault",
    placeholder: "Vault name",
    okLabel: "Continue",
    onOk: async (name) => {
      if (!name) return
      showVaultPassphrase(name)
    },
  })
}

const showVaultPassphrase = (name) => {
  const close = showExtraModal({
    title: `Password for “${esc(name)}”`,
    extraHtml: `
      <p class="modal-note">
        This password cannot be reset. ${VAULT_MIN_PASSPHRASE} characters minimum.
      </p>
      <input type="password" id="vault-new-pass" class="modal-text-input"
             placeholder="Password" autocomplete="new-password" />
      <input type="password" id="vault-new-confirm" class="modal-text-input"
             placeholder="Confirm password" autocomplete="new-password" />
      <p class="vault-error hidden" id="vault-new-error"></p>`,
    okLabel: "Create vault",
    onOk: async () => {
      const pw = document.getElementById("vault-new-pass").value
      const confirm = document.getElementById("vault-new-confirm").value
      const err = document.getElementById("vault-new-error")
      const fail = (msg) => {
        err.textContent = msg
        err.classList.remove("hidden")
      }
      if (pw.length < VAULT_MIN_PASSPHRASE)
        return fail(`Use at least ${VAULT_MIN_PASSPHRASE} characters.`)
      if (pw !== confirm) return fail("The two passwords don't match.")

      const okBtn = document.getElementById("modal-ok")
      okBtn.disabled = true
      okBtn.textContent = "Creating…"
      const dir = relPath(name)
      try {
        await api("POST", "/api/files/mkdir", { path: dir })
      } catch (e) {
        okBtn.disabled = false
        okBtn.textContent = "Create vault"
        return fail(e.message)
      }
      try {
        const code = await Vault.create(dir, pw)
        close()
        await navigate(state.currentPath, { pushHash: false })
        showRecoveryCode(code, dir)
      } catch (e) {
        // A half-built vault is worse than none: drop the folder so the name is free again.
        await api("POST", "/api/files/delete", { path: dir }).catch(() => {})
        close()
        await navigate(state.currentPath, { pushHash: false })
        toast(`Could not create the vault: ${e.message}`, true)
      }
    },
  })
  document.getElementById("vault-new-pass").focus()
}

// Shown once, and never again: this is the only copy outside the passphrase itself.
const showRecoveryCode = (code, dir) => {
  const close = showExtraModal({
    title: "Save your recovery code",
    extraHtml: `
      <p class="modal-note">
        This is the only way into “${esc(baseName(dir))}” if you forget the password. Write it down, or store it in a password manager. It will not be shown again.
      </p>
      <div class="recovery-code" id="recovery-code" title="Click to copy">${esc(code)}</div>
      <label class="modal-check">
        <input type="checkbox" id="recovery-ack" /> I have saved this code
      </label>`,
    okLabel: "Done",
    closeOnly: true,
    okClass: "btn btn-primary",
    // The code exists nowhere else, so Done with the box checked is the only way out.
    dismissible: false,
    // Enter reaches onOk without going through the button, so re-check the box here too.
    onOk: () => {
      if (document.getElementById("recovery-ack").checked) close()
    },
  })
  const okBtn = document.getElementById("modal-ok")
  okBtn.disabled = true
  document.getElementById("recovery-ack").addEventListener("change", (e) => {
    okBtn.disabled = !e.target.checked
  })
  document.getElementById("recovery-code").addEventListener("click", () => {
    copyText(code)
    toast("Recovery code copied")
  })
}

const uploadToVault = async (upload, path) => {
  if (!vaultUnlocked()) {
    toast("Unlock this vault before adding files", true)
    return
  }
  const root = vaultSubOf(path)
  const { files } = upload
  const progressEl = document.getElementById("upload-progress")
  const titleEl = document.getElementById("upload-progress-title")
  const labelEl = document.getElementById("progress-label")
  const barEl = document.getElementById("progress-bar-fill")
  const totalBytes = files.reduce((n, f) => n + f.file.size, 0) || 1
  let doneBytes = 0
  progressEl.classList.add("active")
  barEl.style.width = "0%"
  titleEl.textContent = "Preparing…"
  labelEl.textContent = ""

  // A vault's folders live in its index alone, so no directory is made on disk for one.
  const dirs = await makeUploadDirs(upload, (at, name, unique) =>
    Vault.mkdir(under(root, at), name, { unique })
  )
  // Show the new folders at once; the files inside them aren't on screen to trickle in.
  if (dirs.size > 1 && state.currentPath === path) await navigate(path, { pushHash: false })

  for (let i = 0; i < files.length; i++) {
    const { file, relDir } = files[i]
    const dest = dirs.get(relDir)
    if (dest === undefined) {
      doneBytes += file.size // its folder could not be made, so there is nowhere to put it
      continue
    }
    // Encryption comes first and reports no bytes, so the bar holds where the last file left it.
    titleEl.textContent = `Uploading “${file.name}”`
    labelEl.textContent = `${i + 1} / ${files.length}`
    try {
      await Vault.addFile(file, under(root, dest), {
        onProgress: (loaded) => {
          const at = Math.min(doneBytes + loaded, totalBytes)
          barEl.style.width = `${Math.round((at / totalBytes) * 100)}%`
        },
      })
      // Refresh per file so a long batch fills in as it lands rather than staying empty.
      if (!relDir && state.currentPath === path) await navigate(path, { pushHash: false })
    } catch (e) {
      toast(`Failed to add “${file.name}”: ${e.message}`, true)
    }
    doneBytes += file.size
  }

  if (state.currentPath === path) await navigate(path, { pushHash: false })
  barEl.style.width = "100%"
  labelEl.textContent = "Done"
  setTimeout(() => {
    progressEl.classList.remove("active")
    barEl.style.width = "0"
  }, 1500)
}

// One file at a time: the browser can only be handed bytes it holds, and no server zip reaches in.
const saveVaultFile = async (entry) => {
  try {
    const a = document.createElement("a")
    a.href = await vaultBlobUrl(entry.id)
    a.download = entry.name
    a.click()
  } catch (e) {
    toast(e.message, true)
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

const doLogin = async () => {
  const username = document.getElementById("username-input").value
  const pw = document.getElementById("password-input").value
  const errEl = document.getElementById("login-error")
  errEl.style.display = "none"
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: pw }),
    })
    if (res.status === 429) {
      errEl.textContent = "Too many attempts. Try again later."
      errEl.style.display = "block"
      return
    }
    if (!res.ok) {
      errEl.textContent = "Invalid username or password."
      errEl.style.display = "block"
      return
    }
    document.getElementById("password-input").value = ""
    showApp()
    await handleHashNavigation({ pushHash: false })
    ensureView()
    syncPrefsFromServer()
    syncTagsFromServer()
    startJobPolling() // signing in mid-conversion still has to pick the panel back up
  } catch {
    errEl.textContent = "Connection error."
    errEl.style.display = "block"
  }
}

// ─── Drop box ─────────────────────────────────────────────────────────────────

let dropRowSeq = 0

const dropRowHtml = (name, id) => `
  <div class="dropbox-row" id="${id}">
    <span class="dropbox-row-name">${esc(name)}</span>
    <span class="dropbox-row-state">Waiting</span>
    <span class="dropbox-row-bar"><span class="dropbox-row-fill"></span></span>
  </div>`

const sendToDropBox = async (files) => {
  const list = document.getElementById("dropbox-list")
  const queued = files.map((file) => {
    const id = `dropbox-row-${dropRowSeq++}`
    list.insertAdjacentHTML("beforeend", dropRowHtml(file.name, id))
    return { file, id }
  })

  for (const { file, id } of queued) {
    const row = document.getElementById(id)
    const stateEl = row.querySelector(".dropbox-row-state")
    const fill = row.querySelector(".dropbox-row-fill")
    stateEl.textContent = "Uploading…"
    try {
      const res = await putFile(file, state.share.root, (loaded) => {
        fill.style.width = `${Math.round((loaded / (file.size || 1)) * 100)}%`
      })
      if (!res) return // the link was revoked mid-upload, and showShareGone has taken the page
      fill.style.width = "100%"
      row.classList.add("done")
      stateEl.textContent = "Uploaded"
    } catch (e) {
      row.classList.add("failed")
      stateEl.textContent = e.message
    }
  }
}

const showDropView = (info) => {
  document.getElementById("dropbox-title").textContent = `Upload to “${info.name}”`
  document.getElementById("drop-view").classList.remove("hidden")

  const input = document.getElementById("dropbox-input")
  const zone = document.getElementById("dropbox-zone")
  zone.addEventListener("click", () => input.click())
  input.addEventListener("change", () => {
    if (input.files.length) sendToDropBox([...input.files])
    input.value = "" // so the same file can be sent again after a failure
  })

  for (const ev of ["dragenter", "dragover"])
    zone.addEventListener(ev, (e) => {
      e.preventDefault()
      zone.classList.add("over")
    })
  zone.addEventListener("dragleave", () => zone.classList.remove("over"))
  // Folders are skipped: making one needs a listing, the one thing this link can't have.
  zone.addEventListener("drop", (e) => {
    e.preventDefault()
    zone.classList.remove("over")
    const files = [...(e.dataTransfer?.files || [])]
    if (files.length) sendToDropBox(files)
  })
}

// ─── Install & hand-off ───────────────────────────────────────────────────────

// Owner only: a share visitor caches nothing of the folder and has nothing to install.
const registerWorker = () => {
  if (!("serviceWorker" in navigator) || isShareUrl()) return
  navigator.serviceWorker.register("/sw.js").catch(() => {})
}

// Listings this device cached belong to the session that fetched them, and end with it.
const clearWorkerData = () => {
  navigator.serviceWorker?.controller?.postMessage({ type: "clear-data" })
}

// The worker parked them in a cache and bounced here; a share target can't render its own page.
const takeSharedFiles = async () => {
  if (!new URLSearchParams(location.search).has("shared")) return
  history.replaceState(null, "", location.pathname + location.hash)
  const files = []
  try {
    const cache = await caches.open("sd-share")
    for (const req of await cache.keys()) {
      const res = await cache.match(req)
      if (!res) continue
      const name = decodeURIComponent(res.headers.get("x-name") || "shared")
      const modified = Number(res.headers.get("x-modified")) || Date.now()
      const blob = await res.blob()
      files.push(new File([blob], name, { type: blob.type, lastModified: modified }))
      await cache.delete(req)
    }
  } catch {}
  if (!files.length) return

  showFolderPicker({
    title: files.length === 1 ? `Save “${files[0].name}”` : `Save ${files.length} files`,
    okLabel: "Save here",
    start: state.currentPath,
    onPick: async (dest) => {
      await uploadFiles(asUpload(files), dest)
      if (state.currentPath === dest) navigate(dest)
    },
  })
}

// ─── Init ─────────────────────────────────────────────────────────────────────

// A share link lands on its own folder and never asks the server for the owner's prefs.
const initShare = async () => {
  let info
  try {
    const res = await fetch("/api/share/info")
    if (!res.ok) throw new Error("invalid")
    info = await res.json()
  } catch {
    showShareGone()
    return
  }
  state.share = {
    root: info.path,
    name: info.name,
    mode: info.mode,
    isDir: info.isDir,
    size: info.size,
    modified: info.modified,
  }
  // Whatever this browser cached is the owner's, from their own session on this device.
  state.tags = []
  state.fileTags = {}
  applyShareChrome()
  showApp()
  // A drop link has no listing to route into: giving one is the whole thing it doesn't do.
  if (info.mode === "drop") {
    state.currentPath = info.path
    showDropView(info)
    return
  }
  if (!info.isDir) {
    // The file stands in for the folder a link lands on; there is nothing above it to go to.
    state.currentPath = info.path
    openLoneFile(info.path, info.name)
    return
  }
  // Canonicalize older link forms in place: root-absolute hashes, stray trailing slashes.
  replacePathHash(currentHashPath())
  await handleHashNavigation({ pushHash: false })
  ensureView()
}

const init = async () => {
  // Drop the boot class so .hidden (via showApp/showLogin) governs once auth resolves.
  const settleBoot = () => document.documentElement.classList.remove("boot-login")
  if (isShareUrl()) {
    settleBoot()
    await initShare()
  } else {
    try {
      const res = await fetch("/api/auth/status")
      settleBoot()
      if (res.ok) {
        showApp()
        await handleHashNavigation({ pushHash: false })
        ensureView()
        syncPrefsFromServer()
        syncTagsFromServer()
        startJobPolling() // a transcode queued before a reload is still running on the server
        takeSharedFiles()
      } else {
        showLogin()
      }
    } catch {
      settleBoot()
      // Offline: a signed-in browser still has its last listing cached, which beats a dead form.
      if (document.cookie.split("; ").indexOf("sd_authed=1") !== -1) {
        showApp()
        await handleHashNavigation({ pushHash: false })
        ensureView()
      } else {
        showLogin()
      }
    }
  }

  // Share root↔subfolder moves change the path, so only popstate fires; hash moves fire both.
  const onHistoryMove = () => {
    if (window.location.href !== handledUrl) handleHashNavigation({ pushHash: false })
  }
  window.addEventListener("hashchange", onHistoryMove)
  window.addEventListener("popstate", onHistoryMove)

  document.getElementById("login-form").addEventListener("submit", (e) => {
    e.preventDefault()
    doLogin()
  })

  wireBreadcrumb()

  document.querySelectorAll(".js-home").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.preventDefault()
      navigate(homePath())
    })
  })
  document.querySelectorAll(".js-logout").forEach((el) => {
    el.addEventListener("click", async () => {
      await api("POST", "/api/auth/logout")
      clearWorkerData()
      showLogin()
    })
  })
  document.querySelectorAll(".js-theme-toggle").forEach((el) => {
    el.addEventListener("click", () => {
      setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
    })
  })
  systemTheme.addEventListener("change", () => {
    if (!state.theme) applyTheme()
  })

  const newPopover = document.getElementById("new-popover")

  document.getElementById("new-btn").addEventListener("click", (e) => {
    e.stopPropagation()
    closePopovers(newPopover)
    newPopover.classList.toggle("open")
  })

  document.addEventListener("click", () => newPopover.classList.remove("open"))
  newPopover.addEventListener("click", (e) => e.stopPropagation())

  // Esc closes whichever modal is open, reusing its backdrop-dismiss handler.
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return
    const backdrop = document.getElementById("modal-backdrop")
    if (backdrop.classList.contains("active")) backdrop.onclick?.({ target: backdrop })
  })

  const linkPopover = document.getElementById("link-popover")
  document.addEventListener("click", (e) => {
    if (!linkPopover.contains(e.target)) hideLinkPopover()
  })
  window.addEventListener("scroll", hideLinkPopover, true)
  window.addEventListener("resize", hideLinkPopover)

  const createNewFile = (ext) => {
    showModal({
      title: ext ? `New .${ext} file` : "New file",
      placeholder: ext ? `filename.${ext}` : "filename.ext",
      onOk: async (name) => {
        if (!name) return
        const fileName = ext && !name.endsWith(`.${ext}`) ? `${name}.${ext}` : name
        const path = relPath(fileName)
        try {
          if (state.inVault) {
            // The vault suffixes a name already taken, so open whatever it actually made.
            const id = await Vault.addBytes(vaultSub(), fileName, new Uint8Array(0))
            await navigate(state.currentPath)
            const made = state.entries.find((e) => e.id === id)
            if (made) openEditor(relPath(made.name), made.name)
            return
          }
          await api("POST", "/api/files/write?path=" + encodeURIComponent(path), { content: "" })
          await navigate(state.currentPath)
          openEditor(path, fileName)
        } catch (e) {
          toast(e.message, true)
        }
      },
    })
  }

  document.getElementById("new-folder-btn").addEventListener("click", () => {
    newPopover.classList.remove("open")
    showModal({
      title: "New folder",
      placeholder: "Folder name",
      onOk: async (name) => {
        if (!name) return
        try {
          // A vault's folders live in its index alone, so no directory is made on disk for one.
          if (state.inVault) await Vault.mkdir(vaultSub(), name)
          else await api("POST", "/api/files/mkdir", { path: relPath(name) })
          navigate(state.currentPath)
        } catch (e) {
          toast(e.message, true)
        }
      },
    })
  })

  document.getElementById("new-md-btn").addEventListener("click", () => {
    newPopover.classList.remove("open")
    createNewFile("md")
  })

  document.getElementById("new-other-btn").addEventListener("click", () => {
    newPopover.classList.remove("open")
    createNewFile()
  })

  document.getElementById("new-vault-btn").addEventListener("click", () => {
    newPopover.classList.remove("open")
    showVaultCreate()
  })

  document.getElementById("new-s3-btn").addEventListener("click", () => {
    newPopover.classList.remove("open")
    showS3Mount()
  })

  Vault.setAutoLockHandler(onVaultAutoLock)
  document.getElementById("vault-lock-btn").addEventListener("click", () => lockVault())
  updateVaultToggle()

  const uploadPopover = document.getElementById("upload-popover")

  document.getElementById("upload-btn").addEventListener("click", (e) => {
    // With no folder picking there is nothing to choose between; go straight to the file dialog.
    if (!canPickFolders()) {
      document.getElementById("file-input").click()
      return
    }
    e.stopPropagation()
    closePopovers(uploadPopover)
    uploadPopover.classList.toggle("open")
  })

  document.addEventListener("click", () => uploadPopover.classList.remove("open"))
  uploadPopover.addEventListener("click", (e) => e.stopPropagation())

  for (const [btn, input] of [
    ["upload-files-btn", "file-input"],
    ["upload-folder-btn", "folder-input"],
  ]) {
    document.getElementById(btn).addEventListener("click", () => {
      uploadPopover.classList.remove("open")
      document.getElementById(input).click()
    })
    document.getElementById(input).addEventListener("change", (e) => {
      const files = Array.from(e.target.files)
      e.target.value = ""
      uploadFiles(asUpload(files), state.currentPath)
    })
  }

  document.getElementById("rename-btn").addEventListener("click", () => {
    const [entry] = getSelectedEntries()
    if (entry) showRename(entry)
  })

  document.getElementById("details-btn").addEventListener("click", () => {
    const [entry] = getSelectedEntries()
    if (entry) showDetails(entry)
  })

  const optionsPopover = document.getElementById("options-popover")
  document.getElementById("options-btn").addEventListener("click", (e) => {
    e.stopPropagation()
    closePopovers(optionsPopover)
    optionsPopover.classList.toggle("open")
  })
  // Every item here acts and is done, so the menu closes on any click within it.
  document.addEventListener("click", () => optionsPopover.classList.remove("open"))

  document.getElementById("options-download-btn").addEventListener("click", () => {
    const entries = getSelectedEntries()
    if (!entries.length) return
    if (state.inVault) {
      saveVaultFile(entries[0])
      return
    }
    if (entries.length === 1 && !entries[0].isDir) {
      const rel = relPath(entries[0].name)
      window.location.href = `/api/files/download?path=${encodeURIComponent(rel)}`
    } else {
      downloadZip(entries.map((e) => relPath(e.name)))
    }
  })

  document.getElementById("options-tool-btn").addEventListener("click", () => {
    selectionTool(getSelectedEntries())?.open()
  })

  document.getElementById("options-move-btn").addEventListener("click", () => {
    showMoveTo(getSelectedEntries().filter((e) => !e.isTrash))
  })

  document.getElementById("options-copy-btn").addEventListener("click", () => {
    showCopyTo(getSelectedEntries().filter((e) => !e.isTrash))
  })

  document.querySelectorAll(".js-storage").forEach((el) => {
    el.addEventListener("click", showStorage)
  })

  document.getElementById("options-tags-btn").addEventListener("click", () => {
    const [entry] = getSelectedEntries()
    if (entry) showTagsDialog(entry)
  })

  document.getElementById("options-share-btn").addEventListener("click", () => {
    const [entry] = getSelectedEntries()
    if (entry) showShareDialog(entry)
  })

  document
    .getElementById("delete-btn")
    .addEventListener("click", () => deleteEntries(getSelectedEntries()))

  document.getElementById("files-container").addEventListener("click", (e) => {
    if (!e.target.closest(".file-item, .file-card")) clearSelection()
  })

  document.getElementById("view-toggle-btn").addEventListener("click", () => {
    setViewMode(state.viewMode === "grid" ? "list" : "grid")
    updateViewToggle()
    renderFiles()
  })
  updateViewToggle()

  document.getElementById("search-btn").addEventListener("click", showFileSearch)
  updateTagToggle()

  const sortPopover = document.getElementById("sort-popover")
  document.getElementById("sort-btn").addEventListener("click", (e) => {
    e.stopPropagation()
    closePopovers(sortPopover)
    sortPopover.classList.toggle("open")
  })
  document.addEventListener("click", () => sortPopover.classList.remove("open"))
  sortPopover.addEventListener("click", (e) => e.stopPropagation())
  // Everything here but Tags leaves the menu open; one field row holds both directions.
  document.getElementById("sort-tags-btn").addEventListener("click", () => {
    sortPopover.classList.remove("open")
    showTagManager()
  })
  document
    .querySelectorAll(".sort-popover-item[data-sort], .sort-popover-item[data-toggle]")
    .forEach((item) =>
      item.addEventListener("click", () => {
        if (item.dataset.toggle === "group") {
          setGrouping(state.grouping === "folders" ? "mixed" : "folders")
        } else if (item.dataset.toggle === "hidden") {
          setShowHidden(!state.showHidden)
          applyEntryFilters()
        } else {
          setSort(item.dataset.sort, nextSortDir(item.dataset.sort))
        }
        sortEntries()
        updateSortToggle()
        renderFiles()
      })
    )
  updateSortToggle()

  document.getElementById("editor-back-btn").addEventListener("click", editorBack)
  document.getElementById("editor-save-btn").addEventListener("click", saveEditor)
  document.getElementById("text-editor").addEventListener("input", refreshEditorStatus)

  const editorOptions = document.getElementById("editor-options")
  document.getElementById("editor-options-btn").addEventListener("click", (e) => {
    e.stopPropagation()
    closePopovers(editorOptions)
    editorOptions.classList.toggle("open")
  })
  // Every item here acts and is done, so the menu closes on any click within it.
  document.addEventListener("click", () => editorOptions.classList.remove("open"))

  document.getElementById("editor-rename-btn").addEventListener("click", () => {
    const entry = currentEditorEntry()
    if (entry) showRename(entry, { onRenamed: reopenEditorRenamed })
  })

  document.getElementById("editor-tags-btn").addEventListener("click", () => {
    const entry = currentEditorEntry()
    if (entry) showTagsDialog(entry)
  })

  document.getElementById("editor-share-btn").addEventListener("click", () => {
    const entry = currentEditorEntry()
    if (entry) showShareDialog(entry)
  })

  document.getElementById("editor-details-btn").addEventListener("click", () => {
    const entry = currentEditorEntry() || sharedFileEntry()
    if (entry) showDetails(entry, { onRenamed: reopenEditorRenamed })
  })

  document.getElementById("editor-delete-btn").addEventListener("click", () => {
    const entry = currentEditorEntry()
    if (entry) deleteOpenEntry(entry)
  })

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideLinkPopover()
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      if (!document.getElementById("editor-view").classList.contains("hidden") && canEdit()) {
        e.preventDefault()
        saveEditor()
      }
      return
    }
    if (
      e.key === "Escape" &&
      !document.getElementById("browser-view").classList.contains("hidden")
    ) {
      clearSelection()
    }
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      !e.altKey &&
      (e.key === "a" || e.key === "A") &&
      !document.getElementById("browser-view").classList.contains("hidden") &&
      !(e.target instanceof HTMLInputElement) &&
      !(e.target instanceof HTMLTextAreaElement) &&
      !e.target.isContentEditable
    ) {
      e.preventDefault()
      selectAll()
    }
    if (
      e.key === "g" &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      !document.getElementById("browser-view").classList.contains("hidden") &&
      !(e.target instanceof HTMLInputElement) &&
      !(e.target instanceof HTMLTextAreaElement) &&
      !e.target.isContentEditable
    ) {
      setViewMode(state.viewMode === "grid" ? "list" : "grid")
      updateViewToggle()
      renderFiles()
    }
    if (!document.getElementById("preview-view").classList.contains("hidden")) {
      const modal = document.getElementById("modal-backdrop").classList.contains("active")
      // Paging under an open dialog would swap the file out from under whatever it is doing.
      if (e.key === "ArrowLeft" && !modal) {
        e.preventDefault()
        previewNavigate(-1)
      }
      if (e.key === "ArrowRight" && !modal) {
        e.preventDefault()
        previewNavigate(1)
      }
      // Esc leaves the viewer, but only once its own menus are down; fullscreen already claims it.
      if (e.key === "Escape" && !modal && !document.fullscreenElement) {
        const open = document.querySelector("#preview-view .popover.open")
        if (open) closePopovers()
        else if (
          !(e.target instanceof HTMLInputElement) &&
          !(e.target instanceof HTMLTextAreaElement) &&
          !e.target.isContentEditable
        ) {
          goBackToBrowser()
        }
      }
      // Space is the play key everywhere else; here it beats scrolling a page that doesn't scroll.
      if (e.key === " " && state.previewType === "audio" && spaceIsPlayers(e.target)) {
        // The trim dialog takes the key while it's up: its selection is what's being auditioned.
        const trim = document.getElementById("trim-play")
        const player = audioPlayer()
        if (trim) {
          e.preventDefault()
          trim.click()
        } else if (player && !modal) {
          e.preventDefault()
          if (player.paused) player.play().catch(() => {})
          else player.pause()
        }
      }
    }
  })

  const previewOptions = document.getElementById("preview-options")
  document.getElementById("preview-options-btn").addEventListener("click", (e) => {
    e.stopPropagation()
    closePopovers(previewOptions)
    previewOptions.classList.toggle("open")
  })
  // Every item here acts and is done, so the menu closes on any click within it.
  document.addEventListener("click", () => previewOptions.classList.remove("open"))

  document.getElementById("preview-rename-btn").addEventListener("click", () => {
    const entry = currentPreviewEntry()
    if (entry) showRename(entry, { onRenamed: reopenRenamed })
  })

  document.getElementById("preview-details-btn").addEventListener("click", () => {
    const entry = currentPreviewEntry() || sharedFileEntry()
    if (entry) showDetails(entry, { onRenamed: reopenRenamed })
  })

  document.getElementById("preview-tool-btn").addEventListener("click", () => {
    const entry = currentPreviewEntry()
    const tool = entry && mediaToolFor(entry.name)
    if (tool) tool.open(relPath(entry.name), entry.name)
  })

  document.getElementById("preview-level-btn").addEventListener("click", () => {
    state.audioNormalize = !state.audioNormalize
    savePrefs()
    const entry = currentPreviewEntry()
    // Takes effect on the song already playing, so the difference is audible when toggled.
    if (entry) {
      updatePreviewTool(entry.name)
      loadTrackGain(relPath(entry.name))
      warmVisibleGains(state.entries, (e) => relPath(e.name))
    }
  })

  document.getElementById("jobs-cancel").addEventListener("click", async (e) => {
    const id = e.currentTarget.dataset.id
    if (!id) return
    try {
      await api("POST", "/api/jobs/cancel", { id })
      pollJobs()
    } catch (err) {
      toast(err.message, true)
    }
  })

  document.getElementById("preview-share-btn").addEventListener("click", () => {
    const entry = currentPreviewEntry()
    if (entry) showShareDialog(entry)
  })

  document.getElementById("preview-delete-btn").addEventListener("click", () => {
    const entry = currentPreviewEntry()
    if (entry) deleteOpenEntry(entry)
  })

  document.getElementById("preview-back-btn").addEventListener("click", goBackToBrowser)
  document.getElementById("preview-prev-btn").addEventListener("click", () => previewNavigate(-1))
  document.getElementById("preview-next-btn").addEventListener("click", () => previewNavigate(1))
  setupPreviewSwipe()

  setupDragDrop()
  registerWorker()

  // Once a touch drag is armed/active, stop the page from scrolling under it.
  document.addEventListener(
    "touchmove",
    (e) => {
      if (drag || (gesture && gesture.armed)) e.preventDefault()
    },
    { passive: false }
  )
  // Suppress the iOS/Android long-press context menu while dragging.
  document.addEventListener("contextmenu", (e) => {
    if (drag || (gesture && gesture.armed)) e.preventDefault()
  })
}

document.addEventListener("DOMContentLoaded", init)
