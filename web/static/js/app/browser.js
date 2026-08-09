"use strict"

// ─── Listing cache ────────────────────────────────────────────────────────────

// A folder visited before paints from here at once; the fetch behind it only reconciles what moved.
const MAX_CACHED_LISTINGS = 40
const listingCache = new Map()

// Bumped per navigation, so a listing that lands after the user has moved on can't paint over them.
let navSeq = 0

const cacheListing = (path, data) => {
  // Re-inserted so the Map's insertion order stays least-recently-used first.
  listingCache.delete(path)
  listingCache.set(path, data)
  if (listingCache.size > MAX_CACHED_LISTINGS) listingCache.delete(listingCache.keys().next().value)
}

// Any write can add, rename or remove rows in folders other than the one it happened in.
const invalidateListings = () => listingCache.clear()

const fetchListing = async (path) => {
  const data = await api("GET", `/api/files?path=${encodeURIComponent(path)}`)
  // A name that turned out to be a file has no listing worth keeping.
  if (data && !data.notDir) cacheListing(path, data)
  return data
}

// Two at a time: a warmed folder must not queue up behind others in front of the one being opened.
const MAX_PREFETCHES = 2
let prefetching = 0

// Warmed on the press that selects a folder, which is a whole click ahead of the one that opens it.
const prefetchListing = (path) => {
  if (prefetching >= MAX_PREFETCHES || listingCache.has(path) || Vault.covers(path)) return
  prefetching++
  fetchListing(path)
    .catch(() => {})
    .finally(() => prefetching--)
}

// Paints the fresh listing over the cached one on screen, leaving selection and scroll where set.
const refreshListing = (path, cached, data) => {
  if (state.currentPath !== path) return
  if (JSON.stringify(data) === JSON.stringify(cached)) return
  applyListing(path, data, { pushHash: false, keepSelection: true })
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

  const seq = ++navSeq
  const cached = listingCache.get(hashPath)
  if (cached) {
    showBrowser({ pushHash: false })
    applyListing(hashPath, cached, { pushHash })
  }

  // Name alone can't tell folder from file; the listing resolves it.
  let data
  try {
    data = await fetchListing(hashPath)
  } catch (e) {
    // What is already on screen is this folder; a failed refresh of it is not a reason to leave.
    if (cached) {
      toast(e.message, true)
      return
    }
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
  if (!data || seq !== navSeq) return

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
  if (cached) refreshListing(hashPath, cached, data)
  else applyListing(hashPath, data, { pushHash })
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

const applyListing = (path, data, { pushHash = true, keepSelection = false } = {}) => {
  state.currentPath = path
  state.inVault = data.inVault === true
  // Only the vault's own folder is a real directory; a subfolder's listing carries its root along.
  state.vaultRoot = state.inVault ? data.vaultRoot || path : null
  // Decrypted bytes must not outlive the vault they came from.
  if (!vaultUnlocked()) releaseVaultBlobs()
  // A locked vault's real listing is ciphertext under random ids; the unlock panel stands in.
  state.allEntries = state.inVault && !vaultUnlocked() ? [] : data.entries || []
  state.inMount = data.inMount === true
  noteListedDims(state.allEntries)
  applyEntryFilters()
  loadFolderPrefs()
  sortEntries()
  if (keepSelection) pruneSelection()
  else clearSelection()
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
  const seq = ++navSeq
  // The folder is on screen before the round trip starts; what comes back only reconciles it.
  const cached = listingCache.get(path)
  if (cached) applyListing(path, cached, { pushHash })
  try {
    const data = await fetchListing(path)
    if (!data || seq !== navSeq) return
    if (cached) refreshListing(path, cached, data)
    else applyListing(path, data, { pushHash })
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
// Six is what a browser will open to one host anyway; fewer just leaves the connections idle.
const MAX_CONCURRENT_THUMBS = 6
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
  el.addEventListener("pointerdown", (e) => {
    if (el.__entry.isDir) prefetchListing(relPath(el.__entry.name))
    beginGesture(e, el, el.__entry)
  })

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

// A refreshed listing may have lost rows that were selected; what survives stays selected.
const pruneSelection = () => {
  const names = new Set(state.entries.map((e) => e.name))
  for (const name of state.selected) if (!names.has(name)) state.selected.delete(name)
  // The rows moved, so the anchor an index stood for is no longer the one it points at.
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
