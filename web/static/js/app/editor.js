"use strict"

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
