"use strict"

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
        noteFilesChanged()
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
  strHash(`${file.name}\0${file.size}`) +
  strHash(`${file.lastModified || 0}\0${file.name}`) +
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
      noteFilesChanged()
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
  // The destination decides, not the open folder: the picker can land these in a vault from outside.
  if (Vault.covers(path) || (state.inVault && path === state.currentPath))
    return uploadToVault(upload, path)
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
