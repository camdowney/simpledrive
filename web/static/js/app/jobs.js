"use strict"

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
