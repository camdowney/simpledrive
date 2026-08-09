"use strict"

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

const showTagsDialog = (entry) => showTagsFor(entryPath(entry), entry.name)

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
