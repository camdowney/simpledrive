"use strict"

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
const DISPLAY_MAX = 1920 // the server's display cap; anything larger came back as the original

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

// Keyed by version-stamped path, and holding promises: a listed size is one that resolved already.
const imageDims = new Map()
const dimsKey = (entry, path) => `${path}|${entryVer(entry)}`

// The listing carries what the server knew without opening anything; the rest is asked for per file.
const noteListedDims = (entries) => {
  for (const e of entries)
    if (e.width && e.height)
      imageDims.set(dimsKey(e, entryPath(e)), Promise.resolve({ w: e.width, h: e.height }))
}

// fast=1 reads a header or a sidecar, never the whole picture.
const fetchImageDims = (entry, path) => {
  const key = dimsKey(entry, path)
  if (!imageDims.has(key))
    imageDims.set(
      key,
      api("GET", `/api/files/meta?path=${encodeURIComponent(path)}&fast=1`)
        .then((m) => (m.width && m.height ? { w: m.width, h: m.height } : null))
        .catch(() => null)
    )
  return imageDims.get(key)
}

// Both halves of a neighbour's stand-in, warmed on open: paging can outrun a thumb and its size.
const warmNeighborStandIns = () => {
  for (const delta of [1, -1]) {
    const e = previewNeighbor(delta)
    if (!e || fileType(e.name) !== "image") continue
    // A vault has no thumb to warm, and decrypting on the swipe is what makes the neighbour pop in.
    if (state.inVault) {
      vaultBlobUrl(e.id).catch(() => {})
      continue
    }
    const at = entryPath(e)
    const { thumb } = previewSrcs(e, at, e.name, "image")
    if (!thumb) continue
    new Image().src = thumb // the very URL the stand-in will carry, so it paints from cache
    fetchImageDims(e, at)
  }
}

// A capped thumb says nothing about the original's size, so ask, and hold the box to the answer.
const pinStandIn = (img, entry, path, capped) =>
  fetchImageDims(entry, path).then((d) => {
    if (!d || !img.isConnected) return
    // A big photo is painted as the 1920px re-encode, so that, not the original, is the size to hold.
    const scale = capped ? Math.min(1, DISPLAY_MAX / Math.max(d.w, d.h)) : 1
    img.style.maxWidth = `${Math.round(d.w * scale)}px`
    img.style.maxHeight = `${Math.round(d.h * scale)}px`
  })

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
    if (type !== "audio") {
      stopAudio()
      endAudioSession()
    }
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
    if (standIn) {
      pinSmallStandIn(standIn)
      pinStandIn(standIn, entry, path, !!displayUrl)
    }
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
  // Only a photo zooms, and only its body may claim the pinch the browser would otherwise take.
  view.classList.toggle("has-photo", type === "image")
  resetZoom()
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
  warmNeighborStandIns()
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
  slot.innerHTML = state.share || state.inVault ? "" : tagEditorHtml(path)
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
    if (type === "audio" && original)
      return `<audio controls preload="none" src="${esc(original)}"></audio>`
    // A vault holds no thumb of any kind: a picture already decrypted stands in for itself, and
    // everything else slides in as the spinner its own open is about to show anyway.
    if (state.inVault)
      return type === "image" && original
        ? `<img class="preview-placeholder" src="${esc(original)}" alt="">`
        : `<div class="preview-spinner"></div>`
    if (type === "audio") return ""
    return thumb ? `<img class="preview-placeholder" src="${esc(thumb)}" alt="">` : ""
  }

  // Thumbnails, from the same URLs the grid already loaded, so a drag reveals them without a fetch.
  const mountPeeks = () => {
    clearPeeks()
    for (const delta of [-1, 1]) {
      const entry = neighbor(delta)
      if (!entry) continue
      const type = fileType(entry.name)
      const html = peekHtml(entry, type)
      if (!html) continue
      const pane = document.createElement("div")
      pane.className = "preview-peek"
      pane.dataset.delta = delta
      pane.style.transform = restPos(-delta)
      pane.innerHTML = html
      const standIn = pane.querySelector(".preview-placeholder")
      if (standIn) pinSmallStandIn(standIn)
      // A video's poster isn't pinned: the player fills the rect whatever the file's own size is.
      // A vault's stand-in is the picture itself, and no server call can size a file it can't read.
      if (standIn && type === "image" && !state.inVault)
        pinStandIn(standIn, entry, relPath(entry.name), DISPLAY_EXTS.includes(extOf(entry.name)))
      body.appendChild(pane)
    }
  }

  // Upgrades each thumb to the full image mid-drag, so the neighbour lands sharp, not blurry.
  const sharpenPeeks = () => {
    for (const pane of body.querySelectorAll(".preview-peek")) {
      const entry = neighbor(Number(pane.dataset.delta))
      if (!entry) continue
      const type = fileType(entry.name)
      // Only a picture can be painted into a vault's peek, but any file's bytes are worth starting
      // on now: the open that lands the swipe then waits on a decryption already underway.
      if (state.inVault && type !== "image") {
        vaultBlobUrl(entry.id).catch(() => {})
        continue
      }
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
      // A vault neighbour is decrypted here when the warm-up hasn't already held it.
      const src = state.inVault ? vaultBlobUrl(entry.id) : Promise.resolve(display || original)
      src.then(
        (url) => {
          const img = new Image()
          const swap = () => {
            // The gesture may have ended and cleared the peeks while this was in flight.
            if (pane.isConnected && img.naturalWidth) pane.replaceChildren(img)
          }
          img.src = url
          // decode() rejects some displayable images (huge JPEGs); naturalWidth spots real failures.
          img.decode().then(swap, swap)
        },
        () => {}
      )
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
    // Awaited: a vault decrypts on open, and letting the body home before it does would flash the
    // picture we just slid off back onto the screen.
    await previewNavigate(delta) // rebuilds the body, dropping the peeks with it
    clearPeeks() // an open that failed left the body, and its peeks, as they were
    body.style.transform = ""
    state.previewSliding = false
  }

  body.addEventListener("pointerdown", (e) => {
    // A second finger means pinch/zoom, not a swipe.
    if (start) {
      const drag = start.drag
      start = null
      if (drag) settle(0)
      else clearPeeks()
      return
    }
    if (e.button !== 0) return
    if (state.previewSliding) return
    if (!["image", "video", "audio"].includes(state.previewType)) return
    // A zoomed photo is bigger than its box, so a drag pans it rather than pages away from it.
    if (zoomedIn()) return
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

  // A tap that hides the chrome may turn out to be half a double tap, so the zoom gesture owns it.
  body.addEventListener("pointerup", () => {
    if (!start) return
    const { drag } = start
    start = null
    if (drag) {
      const delta = dir < 0 ? 1 : -1
      // Only the way the finger was last headed pages, and only from that far out its own side.
      const held = Math.sign(dx) === dir && Math.abs(dx) > SWIPE_MIN
      settle(held && !missing(delta) ? delta : 0)
      return
    }
    clearPeeks()
  })

  body.addEventListener("pointercancel", () => {
    const drag = start?.drag
    start = null
    if (drag) settle(0)
    else clearPeeks()
  })
}

// ─── Zoom ─────────────────────────────────────────────────────────────────────

const ZOOM_MAX = 6
const ZOOM_DOUBLE = 2.5 // where a double tap or double click lands
const DOUBLE_TAP_MS = 260

const zoom = { scale: 1, x: 0, y: 0 }
let chromeTapTimer = 0

const zoomedIn = () => zoom.scale > 1

// A stand-in is stretched to the whole box rather than the picture's rect; there's nothing to pan.
const zoomImg = () => document.querySelector("#preview-body > img:not(.preview-placeholder)")

// Panned against the body's whole box, so a zoomed photo runs under the bars but not past its edge.
const applyZoom = (animate = false) => {
  const img = zoomImg()
  if (!img) return
  const body = document.getElementById("preview-body")
  const maxX = Math.max(0, (img.offsetWidth * zoom.scale - body.clientWidth) / 2)
  const maxY = Math.max(0, (img.offsetHeight * zoom.scale - body.clientHeight) / 2)
  zoom.x = Math.min(maxX, Math.max(-maxX, zoom.x))
  zoom.y = Math.min(maxY, Math.max(-maxY, zoom.y))
  img.classList.toggle("zoom-anim", animate)
  img.classList.toggle("zoomed", zoomedIn())
  img.style.transform = zoomedIn() ? `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` : ""
}

// Holds whatever sits under the cursor or the pinch's midpoint still while the scale grows past it.
const zoomAt = (scale, px, py, animate = false) => {
  if (!zoomImg()) return
  const next = Math.min(ZOOM_MAX, Math.max(1, scale))
  const box = document.getElementById("preview-body").getBoundingClientRect()
  const cx = box.left + box.width / 2
  const cy = box.top + box.height / 2
  const u = (px - cx - zoom.x) / zoom.scale
  const v = (py - cy - zoom.y) / zoom.scale
  zoom.x = px - cx - u * next
  zoom.y = py - cy - v * next
  zoom.scale = next
  applyZoom(animate)
}

const resetZoom = () => {
  clearTimeout(chromeTapTimer)
  zoom.scale = 1
  zoom.x = zoom.y = 0
  applyZoom()
}

// Pinch, wheel and double tap zoom a photo; a drag pans it once it outgrows the screen.
const setupPreviewZoom = () => {
  const body = document.getElementById("preview-body")
  const pts = new Map() // live pointers, each holding where it went down
  let pinch = null
  let pan = null
  let tapAt = 0
  let touched = false

  const zoomable = () => state.previewType === "image" && !!zoomImg()

  // The first two pointers own the pinch; a Map keeps them in the order they landed.
  const spread = () => {
    const [a, b] = [...pts.values()]
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 }
  }

  const toggleAt = (x, y) => zoomAt(zoomedIn() ? 1 : ZOOM_DOUBLE, x, y, true)

  // The chrome waits out the double tap window: a second tap zooms, and must not flip it as well.
  const tap = (x, y) => {
    const now = Date.now()
    if (now - tapAt < DOUBLE_TAP_MS) {
      clearTimeout(chromeTapTimer)
      tapAt = 0
      toggleAt(x, y)
      return
    }
    tapAt = now
    chromeTapTimer = setTimeout(
      () => document.getElementById("preview-view").classList.toggle("chrome-hidden"),
      DOUBLE_TAP_MS
    )
  }

  body.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || !zoomable()) return
    touched = e.pointerType === "touch"
    const x = e.clientX
    const y = e.clientY
    pts.set(e.pointerId, { x, y, sx: x, sy: y, at: Date.now(), touch: touched, moved: false })
    if (pts.size === 2) {
      for (const p of pts.values()) p.moved = true // neither finger of a pinch can end as a tap
      // A pinch settles the tap before it: it neither completes a double tap nor flips the chrome.
      clearTimeout(chromeTapTimer)
      tapAt = 0
      pinch = spread()
      pan = null
    } else if (pts.size === 1 && zoomedIn()) {
      pan = { x: e.clientX, y: e.clientY }
      if (!touched) {
        // A mouse dragged off the photo would drop the pan, and drag the image natively instead.
        body.setPointerCapture(e.pointerId)
        e.preventDefault()
      }
    }
  })

  body.addEventListener("pointermove", (e) => {
    const p = pts.get(e.pointerId)
    if (!p) return
    p.x = e.clientX
    p.y = e.clientY
    if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > SWIPE_SLOP) p.moved = true
    if (pinch && pts.size >= 2) {
      const now = spread()
      // Fingers that travel together pan; the change in their spread is what scales.
      zoom.x += now.mx - pinch.mx
      zoom.y += now.my - pinch.my
      zoomAt(zoom.scale * (pinch.dist ? now.dist / pinch.dist : 1), now.mx, now.my)
      pinch = now
    } else if (pan) {
      zoom.x += e.clientX - pan.x
      zoom.y += e.clientY - pan.y
      pan = { x: e.clientX, y: e.clientY }
      applyZoom()
    }
  })

  const release = (e) => {
    const p = pts.get(e.pointerId)
    if (!p) return null
    pts.delete(e.pointerId)
    if (pts.size < 2) pinch = null
    // Lifting one finger of a pinch hands the gesture to the other, so the photo keeps panning.
    const [rest] = [...pts.values()]
    pan = rest && zoomedIn() ? { x: rest.x, y: rest.y } : null
    return p
  }

  body.addEventListener("pointerup", (e) => {
    const p = release(e)
    // Click-to-hide would take the desktop chrome's own nav buttons with it, so it stays a tap.
    if (!p || !p.touch || p.moved || pts.size) return
    if (Date.now() - p.at < 400) tap(e.clientX, e.clientY)
  })

  body.addEventListener("pointercancel", release)

  body.addEventListener(
    "wheel",
    (e) => {
      if (!zoomable()) return
      e.preventDefault()
      const step = e.deltaY * (e.deltaMode ? 33 : 1) // Firefox reports lines, not pixels
      zoomAt(zoom.scale * Math.exp(-step * 0.002), e.clientX, e.clientY)
    },
    { passive: false }
  )

  body.addEventListener("dblclick", (e) => {
    // A double tap is already handled as one; the emulated dblclick behind it would undo the zoom.
    if (touched || !zoomable()) return
    toggleAt(e.clientX, e.clientY)
  })
}
