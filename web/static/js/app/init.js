"use strict"

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
  setupPreviewZoom()

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
