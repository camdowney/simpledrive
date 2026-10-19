"use strict"

// ─── Audio playback ───────────────────────────────────────────────────────────

const AUDIO_MODE_LABEL = { off: "Autoplay off", sequential: "In order", shuffle: "Shuffle" }
// Only the off label names the control, so the two that don't lean on the aria to say what it is.
const audioModeAria = () =>
  state.audioMode === "off" ? "Autoplay off" : `Autoplay: ${AUDIO_MODE_LABEL[state.audioMode]}`
const AUDIO_MODE_NEXT = { off: "sequential", sequential: "shuffle", shuffle: "off" }
const TAG_KEEP_SECS = 15 // heard this much and the song earns the tag; skipped sooner, it loses it

// The one song player, in the viewer or the bar; a swipe's peek mounts its own, as scenery.
let songPlayer = null
const audioPlayer = () => songPlayer

// Not the paging queue: an archive opens without joining it, and a tag filter can drop it out.
const currentPreviewEntry = () => state.previewEntry

// Against the run's own folder, which the listing may have moved on from.
const songPath = (e) => joinPath(state.audioDir, e.name)

// An empty result would strand playback, so a tag selection nothing matches falls back to all.
const audioQueue = () => {
  const songs = state.audioFiles.filter((e) => fileType(e.name) === "audio")
  if (!state.audioTags.size) return songs
  const kept = songs.filter((e) =>
    (state.fileTags[songPath(e)] || []).some((id) => state.audioTags.has(id))
  )
  return kept.length ? kept : songs
}

const queuePos = (queue) => {
  const cur = state.audioSong
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
  const has = (e) => (state.fileTags[songPath(e)] || []).includes(state.audioTagging)
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
  const cur = state.audioSong?.name
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
  const cur = state.audioSong?.name
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
  const cur = state.audioSong?.name
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

// Where a skip lands in the run; `trail` gives what back off its head leaves for, if anything.
const songNeighbor = (delta, trail = () => null) => {
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
  const from = trail()
  if (from) return from
  if (state.audioMode === "shuffle") return dealBack(songs, mixShare()) || order.at(-1)
  return order.at(-1)
}

// What paging lands on: a song steps through the play queue, anything else through the folder.
const previewNeighbor = (delta) => {
  // A file outside the paging queue (an archive) sits at -1, where +1 would land on the first.
  if (state.previewIdx < 0 && state.previewType !== "audio") return undefined
  if (state.previewType !== "audio") return state.previewFiles[state.previewIdx + delta]
  return songNeighbor(delta, trailBack)
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
  on("previoustrack", () => skipSong(-1))
  on("nexttrack", () => skipSong(1))
}

const songTitle = (name) => name.replace(/\.[^.]+$/, "")

const setMediaMetadata = ({ path, name }) => {
  const ms = navigator.mediaSession
  if (!ms || !window.MediaMetadata) return
  ms.metadata = new MediaMetadata({
    title: songTitle(name),
    album: parentPath(path).split("/").filter(Boolean).pop() || "",
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
    [songNeighbor(-1), songNeighbor(1)]
      .filter((e) => e && fileType(e.name) === "audio")
      .map(songPath),
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
    syncNowPlayingVolume()
  })
  const mark = (s) => navigator.mediaSession && (navigator.mediaSession.playbackState = s)
  player.addEventListener("play", () => mark("playing"))
  player.addEventListener("pause", () => mark("paused"))
  for (const ev of ["play", "pause"]) player.addEventListener(ev, syncNowPlayingToggle)
  player.addEventListener("timeupdate", syncNowPlayingProgress)
  // iOS falls back to its own skip buttons unless the handlers are re-registered per src load.
  player.addEventListener("loadedmetadata", () => {
    wireMediaSession(player)
    if (state.audioSong) setMediaMetadata(state.audioSong)
  })
  player.addEventListener("ended", () => {
    // Settling clears the track the run's position is read from, so take it before that.
    const fromHead = state.audioTrack?.path === state.audioHead
    const moved = settleTagging(true)
    if (state.audioMode !== "off") return skipSong(1, { fromHead })
    // A rebuild would close whatever menu the bar has open, so redraw only if the chips changed.
    const entry = currentPreviewEntry()
    if (moved && entry && !inBar) renderPreviewBar(relPath(entry.name), "audio")
  })
  wireMediaSession(player)
  songPlayer = player
  return player
}

// Shared by the viewer and the bar: points the one player at a song and starts it.
const loadSong = (path, name, url, { paging = false } = {}) => {
  const player = audioPlayer() || buildAudioPlayer()
  player.src = url
  player.play().catch(() => {}) // a reused player has no autoplay pass of its own
  loadTrackGain(path)
  state.audioSong = { path, name }
  setMediaMetadata(state.audioSong)
  state.audioTrack = { path, name }
  // A song picked outside of paging starts its own run, so it is the newest by definition.
  if (!paging) state.audioHead = path
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

// The filter and the autotag pass belong to one listening session; ending it drops both.
const endAudioSession = () => {
  state.audioTags.clear()
  state.audioTagging = null
  shuffleOrder = []
}

// ─── Now playing bar ──────────────────────────────────────────────────────────

let inBar = false
const songInBar = () => inBar

// Only over the tabbed screens: the editor's leave guard would be skipped by opening the viewer.
const syncNowPlaying = () => {
  const shown = (id) => !document.getElementById(id).classList.contains("hidden")
  const bar = document.getElementById("now-playing")
  bar.classList.toggle("hidden", !inBar || !(shown("browser-view") || shown("storage-view")))
  if (!inBar) return
  document.getElementById("now-playing-name").textContent = songTitle(state.audioSong.name)
  syncNowPlayingToggle()
  syncNowPlayingProgress()
  syncNowPlayingVolume()
}

const syncNowPlayingVolume = () => {
  const slider = document.getElementById("now-playing-volume")
  slider.classList.toggle("hidden", VOLUME_LOCKED)
  slider.value = userVolume
}

const syncNowPlayingToggle = () => {
  const paused = !songPlayer || songPlayer.paused
  const btn = document.getElementById("now-playing-toggle")
  btn.setAttribute("aria-label", paused ? "Play" : "Pause")
  btn.querySelector("use").setAttribute("href", paused ? "#icon-play" : "#icon-pause")
}

let seekDragging = false

const paintSeek = (frac) => {
  const seek = document.getElementById("now-playing-seek")
  seek.value = Math.round(frac * 1000)
  seek.style.setProperty("--progress", `${frac * 100}%`)
}

const syncNowPlayingProgress = () => {
  // Playback would otherwise drag the thumb back out from under the finger.
  if (!inBar || seekDragging) return
  const { currentTime, duration } = songPlayer
  paintSeek(isFinite(duration) && duration > 0 ? currentTime / duration : 0)
}

// Leaving the viewer mid-song hands the player to the bar rather than silencing it.
const sendSongToBar = () => {
  if (inBar) return true
  // A vault song plays from decrypted bytes that are released along with the vault.
  if (state.previewType !== "audio" || state.inVault || !songPlayer?.src || songPlayer.paused)
    return false
  // Moved within one task, so it's never out of the document long enough to be paused for it.
  document.getElementById("now-playing").prepend(songPlayer)
  inBar = true
  syncNowPlaying()
  return true
}

const takeSongFromBar = () => {
  inBar = false
  syncNowPlaying()
}

const stopSongInBar = () => {
  settleTagging(false, { keepOnly: true })
  endAudioSession()
  stopAudio()
  takeSongFromBar()
}

// The bar walks the same queue the viewer would, loading each song straight into the player.
const songNavigate = (delta, { fromHead = null } = {}) => {
  const entry = songNeighbor(delta)
  if (!entry) return
  const back = delta < 0
  settleTagging(false, { keepOnly: back })
  const extend = !back && (fromHead ?? state.audioTrack?.path === state.audioHead)
  const path = songPath(entry)
  const url = previewSrcs(entry, path, entry.name, "audio", false).original
  loadSong(path, entry.name, url, { paging: true })
  if (extend) state.audioHead = path
  syncNowPlaying()
  warmNeighborGains()
}

const skipSong = (delta, opts) => (inBar ? songNavigate(delta, opts) : previewNavigate(delta, opts))

// The viewer's queue and paging are built from the listing, so the song's folder comes first.
const openSongFromBar = async () => {
  const { name } = state.audioSong
  if (state.currentPath !== state.audioDir) await navigate(state.audioDir, { pushHash: false })
  const entry = state.entries.find((e) => e.name === name)
  if (entry) openPreview(songPath(entry), name, "audio")
  else toast("Couldn't find this song in its folder", true)
}

const wireNowPlaying = () => {
  const on = (id, fn) => document.getElementById(id).addEventListener("click", fn)
  on("now-playing-open", openSongFromBar)
  on("now-playing-prev", () => songNavigate(-1))
  on("now-playing-next", () => songNavigate(1))
  on("now-playing-close", stopSongInBar)
  // Seeks once, on release: every step of a drag would be a fresh range request.
  const seek = document.getElementById("now-playing-seek")
  const commitSeek = () => {
    if (!seekDragging) return
    seekDragging = false
    const { duration } = songPlayer
    if (isFinite(duration) && duration > 0) songPlayer.currentTime = (seek.value / 1000) * duration
  }
  seek.addEventListener("pointerdown", () => (seekDragging = true))
  seek.addEventListener("input", () => {
    seekDragging = true // keyboard steps arrive with no pointer down first
    paintSeek(seek.value / 1000)
  })
  // A long hold can end without a change event, so any way the press ends commits it.
  seek.addEventListener("change", commitSeek)
  for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, commitSeek)
  // Set as the user's level, so the song's loudness gain stays applied on top of it.
  document.getElementById("now-playing-volume").addEventListener("input", (e) => {
    userVolume = clamp01(Number(e.target.value))
    applyTrackGain(trackGain)
  })
  on("now-playing-toggle", () => {
    if (songPlayer.paused) songPlayer.play().catch(() => {})
    else songPlayer.pause()
  })
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
