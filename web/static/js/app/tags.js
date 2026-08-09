"use strict"

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
