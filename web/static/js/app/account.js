"use strict"

// ─── Vault ────────────────────────────────────────────────────────────────────

// Plaintext lives only in this tab: the server holds age ciphertext and never sees the passphrase.
// The index becomes an ordinary listing and the blobs blob: URLs, so the usual views work.

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
        This password cannot be reset. 12+ characters recommended.
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
      if (!pw) return fail("Enter a password.")
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
  invalidateListings()
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
