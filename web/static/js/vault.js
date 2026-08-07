// Client-side encrypted folders. The server stores age ciphertext and never sees a passphrase
// or a plaintext byte; everything below runs in the page.
//
// Layout of a vault folder, and why it is shaped this way:
//
//   vault.key.age        the vault's age identity, encrypted under the user's passphrase
//   vault.recovery.age   the same identity, encrypted under a printed recovery code
//   index.age            blob id -> real filename and folder, encrypted to the identity
//   RECOVERY.md          plaintext instructions, so a backup explains itself
//   <32 hex chars>       one file, encrypted to the identity
//
// Encrypting straight to the passphrase would rerun scrypt on every single file open. Instead
// the passphrase guards one small key file, and everything else is encrypted to the identity's
// recipient, which is fast. Changing the passphrase rewrites vault.key.age alone.
//
// Subfolders live in the index only: every blob sits flat in the one directory, so a folder's
// name is ciphertext like everything else and the tree leaks nothing but its shape.
const Vault = (() => {
  const KEY_FILE = "vault.key.age"
  const RECOVERY_FILE = "vault.recovery.age"
  const INDEX_FILE = "index.age"
  const DOC_FILE = "RECOVERY.md"

  // Files that are vault machinery rather than user content, and so never appear in the listing.
  const RESERVED = new Set([KEY_FILE, RECOVERY_FILE, INDEX_FILE, DOC_FILE])

  // Unlocked state. Held only here, never in localStorage, and dropped on lock or reload.
  let open = null // { path, identity, recipient, index, idleTimer }

  // Auto-lock after inactivity, so an unattended tab does not leave the vault readable.
  const IDLE_MS = 15 * 60 * 1000
  let onAutoLock = null

  const openPath = () => open && open.path

  // True for the vault's own folder and everything below it, which is all served from the index.
  const covers = (path) => !!open && (path === open.path || path.startsWith(open.path + "/"))

  // A transfer in flight is activity: auto-locking mid-upload would strand the file it was writing.
  let busy = 0
  const whileBusy = async (p) => {
    busy++
    try {
      return await p
    } finally {
      busy--
      bump()
    }
  }

  const bump = () => {
    if (!open) return
    clearTimeout(open.idleTimer)
    open.idleTimer = setTimeout(() => {
      if (busy) return bump()
      lock()
      onAutoLock?.()
    }, IDLE_MS)
  }

  const lock = () => {
    if (!open) return
    clearTimeout(open.idleTimer)
    open = null
  }

  const setAutoLockHandler = (fn) => {
    onAutoLock = fn
  }

  // ── Virtual paths ───────────────────────────────────────────────────────────

  // Folders are index keys, not directories, so they are normalized to "/" or "/a/b" throughout.
  const normDir = (p) =>
    "/" +
    String(p || "")
      .split("/")
      .filter(Boolean)
      .join("/")
  const childDir = (dir, name) => (dir === "/" ? "/" + name : dir + "/" + name)
  const baseOf = (p) => p.slice(p.lastIndexOf("/") + 1)
  const parentOf = (p) => p.slice(0, p.lastIndexOf("/")) || "/"
  const atOrUnder = (p, dir) => p === dir || p.startsWith(dir === "/" ? "/" : dir + "/")

  // ── Wire helpers ────────────────────────────────────────────────────────────

  const filePath = (dir, name) => (dir.replace(/\/$/, "") + "/" + name).replace(/^\/\//, "/")

  const getBytes = async (dir, name) => {
    const res = await fetch(`/api/files/download?path=${encodeURIComponent(filePath(dir, name))}`)
    if (!res.ok) throw new Error(`could not read ${name}`)
    return new Uint8Array(await res.arrayBuffer())
  }

  // Blobs are written once under a fresh id; only index.age is ever replaced in place.
  // XHR rather than fetch: a vault writes each file in one request, and only XHR says how much
  // of it has actually left the page.
  const putBytes = (dir, name, bytes, { overwrite = false, onProgress } = {}) =>
    new Promise((resolve, reject) => {
      const fd = new FormData()
      fd.append("files", new Blob([bytes], { type: "application/octet-stream" }), name)
      const xhr = new XMLHttpRequest()
      xhr.open(
        "POST",
        `/api/files/upload?path=${encodeURIComponent(dir)}` + (overwrite ? "&overwrite=1" : "")
      )
      if (onProgress) {
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded)
        }
      }
      xhr.onload = () => {
        let data = null
        try {
          data = JSON.parse(xhr.responseText)
        } catch {}
        if (xhr.status < 200 || xhr.status >= 300)
          return reject(new Error(data?.error || `could not write ${name}`))
        const saved = data?.saved || []
        // Without overwrite the server renames on collision; a silent rename would orphan the blob.
        if (!overwrite && saved[0] !== name) return reject(new Error(`unexpected name ${saved[0]}`))
        resolve()
      }
      xhr.onerror = () => reject(new Error(`could not write ${name}`))
      xhr.send(fd)
    })

  const deleteFile = async (dir, name) => {
    const res = await fetch("/api/files/delete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: filePath(dir, name) }),
    })
    if (!res.ok) throw new Error(`could not delete ${name}`)
  }

  // ── Crypto ──────────────────────────────────────────────────────────────────

  // Every age call below runs in a worker: it works a whole file at a time and never yields, so
  // on the main thread a large file is a frozen tab rather than a slow one.
  let ready = null // Promise<Worker|null>, settled once the worker has shown it loaded
  let jobSeq = 0
  const jobs = new Map()

  // Nothing is sent until the worker answers: a script that fails to load has to fall back to the
  // page, not take the first file down with it.
  const startWorker = () =>
    new Promise((resolve) => {
      let w
      try {
        w = new Worker("/static/js/vault-worker.js")
      } catch {
        return resolve(null)
      }
      w.onmessage = ({ data }) => {
        if (data.ready) return resolve(w)
        const job = jobs.get(data.id)
        if (!job) return
        jobs.delete(data.id)
        if (data.error) job.reject(new Error(data.error))
        else job.resolve(data.out)
      }
      w.onerror = () => {
        w.terminate()
        ready = Promise.resolve(null)
        for (const job of jobs.values()) job.reject(new Error("vault crypto failed"))
        jobs.clear()
        resolve(null)
      }
    })

  // Detaches bytes: the buffer is handed over rather than copied, which halves peak memory on a
  // large file. Every caller passes an array it has just built, so nothing else can be holding it.
  const inWorker = async (msg, bytes) => {
    if (!ready) ready = startWorker()
    const w = await ready
    if (!w) return null
    return await new Promise((resolve, reject) => {
      const id = ++jobSeq
      jobs.set(id, { resolve, reject })
      w.postMessage({ ...msg, id, bytes }, [bytes.buffer])
    })
  }

  const asBytes = (data) => (typeof data === "string" ? new TextEncoder().encode(data) : data)

  const encToRecipient = async (recipient, data) => {
    const bytes = asBytes(data)
    const out = await inWorker({ op: "encrypt", recipient }, bytes)
    if (out) return out
    const enc = new age.Encrypter()
    enc.addRecipient(recipient)
    return await enc.encrypt(bytes)
  }

  const encToPassphrase = async (passphrase, data) => {
    const bytes = asBytes(data)
    const out = await inWorker({ op: "encryptPassphrase", passphrase }, bytes)
    if (out) return out
    const enc = new age.Encrypter()
    enc.setPassphrase(passphrase)
    return await enc.encrypt(bytes)
  }

  const asFormat = (out, format) => (format === "text" ? new TextDecoder().decode(out) : out)

  const decWithIdentity = async (identity, bytes, format) => {
    const out = await inWorker({ op: "decrypt", identity }, bytes)
    if (out) return asFormat(out, format)
    const dec = new age.Decrypter()
    dec.addIdentity(identity)
    return await dec.decrypt(bytes, format)
  }

  const decWithPassphrase = async (passphrase, bytes, format) => {
    const out = await inWorker({ op: "decryptPassphrase", passphrase }, bytes)
    if (out) return asFormat(out, format)
    const dec = new age.Decrypter()
    dec.addPassphrase(passphrase)
    return await dec.decrypt(bytes, format)
  }

  const randomId = () => {
    const b = new Uint8Array(16)
    crypto.getRandomValues(b)
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")
  }

  // Crockford-style alphabet: no I/L/O/U, so a code read off paper can't be mistyped into another.
  const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
  const makeRecoveryCode = () => {
    const b = new Uint8Array(20)
    crypto.getRandomValues(b)
    const chars = Array.from(b, (x) => RECOVERY_ALPHABET[x % RECOVERY_ALPHABET.length])
    return chars
      .join("")
      .match(/.{1,5}/g)
      .join("-")
  }

  // ── Index ───────────────────────────────────────────────────────────────────

  const emptyIndex = () => ({ v: 2, files: {}, dirs: {} })

  // v1 had no folders, so everything it holds sits at the root of the tree v2 reads.
  const upgrade = (parsed) => {
    const index = { v: 2, files: parsed.files || {}, dirs: parsed.dirs || {} }
    for (const meta of Object.values(index.files)) meta.dir = normDir(meta.dir)
    return index
  }

  const readIndex = async (dir, identity) => {
    let text
    try {
      text = await decWithIdentity(identity, await getBytes(dir, INDEX_FILE), "text")
    } catch {
      // A vault with no index yet is empty, not broken; a corrupt one must not erase itself.
      return emptyIndex()
    }
    const parsed = JSON.parse(text)
    return parsed && parsed.files ? upgrade(parsed) : emptyIndex()
  }

  const writeIndex = async () => {
    const bytes = await encToRecipient(open.recipient, JSON.stringify(open.index))
    await putBytes(open.path, INDEX_FILE, bytes, { overwrite: true })
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  // Creates the vault files in an existing empty folder. Returns the recovery code, which is
  // shown once and never stored: it is the only way back in if the passphrase is forgotten.
  const create = async (dir, passphrase) => {
    const identity = await age.generateIdentity()
    const recipient = await age.identityToRecipient(identity)
    const recoveryCode = makeRecoveryCode()

    await putBytes(dir, KEY_FILE, await encToPassphrase(passphrase, identity))
    await putBytes(dir, RECOVERY_FILE, await encToPassphrase(recoveryCode, identity))
    await putBytes(dir, INDEX_FILE, await encToRecipient(recipient, JSON.stringify(emptyIndex())))
    await putBytes(dir, DOC_FILE, new TextEncoder().encode(recoveryDoc()))

    open = { path: dir, identity, recipient, index: emptyIndex(), idleTimer: null }
    bump()
    return recoveryCode
  }

  // Accepts either the passphrase or the recovery code; both unwrap the same identity.
  const unlock = async (dir, secret) => {
    let identity = null
    for (const name of [KEY_FILE, RECOVERY_FILE]) {
      try {
        identity = await decWithPassphrase(secret, await getBytes(dir, name), "text")
        break
      } catch {
        // Wrong secret for this file; try the other before calling it a failure.
      }
    }
    if (!identity) throw new Error("Wrong password.")
    const recipient = await age.identityToRecipient(identity)
    const index = await readIndex(dir, identity)
    open = { path: dir, identity, recipient, index, idleTimer: null }
    bump()
    refreshDoc(dir) // an older vault's copy describes an older index; unlocking is when to fix that
    return index
  }

  // The instructions are only worth keeping if they still match the format they describe, so a
  // vault made by an earlier version has its copy brought up to date. Best effort: a read-only
  // backup medium is a fine place for a stale doc, and no reason to refuse to open the vault.
  const refreshDoc = async (dir) => {
    try {
      const want = recoveryDoc()
      const have = new TextDecoder().decode(await getBytes(dir, DOC_FILE))
      if (have === want) return
      await putBytes(dir, DOC_FILE, new TextEncoder().encode(want), { overwrite: true })
    } catch {}
  }

  // Rewrites only the key file, so the files themselves are untouched.
  const changePassphrase = async (next) => {
    const key = await encToPassphrase(next, open.identity)
    await putBytes(open.path, KEY_FILE, key, { overwrite: true })
  }

  // ── Contents ────────────────────────────────────────────────────────────────

  // One folder's children, shaped like the server's listing so the browser renders them the same.
  const list = (dir = "/") => {
    if (!open) return []
    const at = normDir(dir)
    const out = []
    for (const [path, meta] of Object.entries(open.index.dirs)) {
      if (parentOf(path) !== at) continue
      out.push({ name: baseOf(path), size: 0, modified: meta.modified || null, isDir: true })
    }
    for (const [id, meta] of Object.entries(open.index.files)) {
      if (normDir(meta.dir) !== at) continue
      out.push({
        id,
        name: meta.name,
        size: meta.size || 0,
        modified: meta.modified || null,
        mime: meta.mime || "",
        isDir: false,
      })
    }
    return out
  }

  const hasDir = (dir) => !!open && (normDir(dir) === "/" || !!open.index.dirs[normDir(dir)])

  const idAt = (dir, name) => {
    const at = normDir(dir)
    for (const [id, meta] of Object.entries(open.index.files)) {
      if (normDir(meta.dir) === at && meta.name === name) return id
    }
    return null
  }

  const takenIn = (dir) => {
    const at = normDir(dir)
    const names = new Set()
    for (const meta of Object.values(open.index.files)) {
      if (normDir(meta.dir) === at) names.add(meta.name)
    }
    for (const path of Object.keys(open.index.dirs)) {
      if (parentOf(path) === at) names.add(baseOf(path))
    }
    return names
  }

  // Display names double as the listing's identity, so a repeat upload is suffixed, not merged.
  // keepExt false for a folder: its dots are part of the name, not an extension.
  const uniqueName = (dir, name, { keepExt = true } = {}) => {
    const taken = takenIn(dir)
    if (!taken.has(name)) return name
    const dot = keepExt ? name.lastIndexOf(".") : -1
    const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""]
    for (let i = 1; ; i++) {
      const next = `${base} (${i})${ext}`
      if (!taken.has(next)) return next
    }
  }

  // Returns the name used, which unique suffixes past a clash instead of refusing outright.
  const mkdir = async (dir, name, { unique = false } = {}) => {
    bump()
    const at = normDir(dir)
    if (!unique && takenIn(at).has(name))
      throw new Error("A file or folder with that name already exists.")
    const final = unique ? uniqueName(at, name, { keepExt: false }) : name
    open.index.dirs[childDir(at, final)] = { modified: new Date().toISOString() }
    await writeIndex()
    return final
  }

  const addBytes = async (dir, name, bytes, opts = {}) => {
    bump()
    const at = normDir(dir)
    const id = randomId()
    const size = bytes.length // encrypting detaches bytes, so the length is taken while it is there
    const session = open
    const blob = await whileBusy(encToRecipient(session.recipient, bytes))
    await whileBusy(putBytes(session.path, id, blob, { onProgress: opts.onProgress }))
    // Locking mid-transfer leaves nothing to file the blob under; the stray blob is inert.
    if (open !== session) throw new Error("the vault was locked before this file finished")
    open.index.files[id] = {
      name: uniqueName(at, name),
      dir: at,
      size,
      // Kept because a decrypted blob has no filename for the browser to sniff a type from.
      mime: opts.mime || "",
      modified: opts.modified || new Date().toISOString(),
    }
    await writeIndex()
    return id
  }

  const addFile = async (file, dir, opts = {}) =>
    addBytes(dir, file.name, new Uint8Array(await file.arrayBuffer()), {
      ...opts,
      mime: file.type || "",
      modified: new Date(file.lastModified || Date.now()).toISOString(),
    })

  // Returns the plaintext bytes. The caller owns them and should drop the reference when done.
  const readFile = async (id) => {
    bump()
    const meta = open.index.files[id]
    if (!meta) throw new Error("not in this vault")
    const blob = await whileBusy(getBytes(open.path, id))
    const plain = await whileBusy(decWithIdentity(open.identity, blob))
    return { name: meta.name, bytes: plain, mime: meta.mime || "" }
  }

  // Re-encrypts in place under the same blob id, so an edit doesn't churn the folder.
  const writeFile = async (id, bytes) => {
    bump()
    const meta = open.index.files[id]
    if (!meta) throw new Error("not in this vault")
    const size = bytes.length // encrypting detaches bytes, so the length is taken while it is there
    const blob = await whileBusy(encToRecipient(open.recipient, bytes))
    await whileBusy(putBytes(open.path, id, blob, { overwrite: true }))
    meta.size = size
    meta.modified = new Date().toISOString()
    await writeIndex()
  }

  const rename = async (dir, from, to) => {
    bump()
    const at = normDir(dir)
    if (from === to) return
    if (takenIn(at).has(to)) throw new Error("A file or folder with that name already exists.")
    const id = idAt(at, from)
    if (id) {
      open.index.files[id].name = to
      await writeIndex()
      return
    }
    const oldPath = childDir(at, from)
    if (!open.index.dirs[oldPath]) return
    const newPath = childDir(at, to)
    for (const path of Object.keys(open.index.dirs)) {
      if (!atOrUnder(path, oldPath)) continue
      open.index.dirs[newPath + path.slice(oldPath.length)] = open.index.dirs[path]
      delete open.index.dirs[path]
    }
    for (const meta of Object.values(open.index.files)) {
      const d = normDir(meta.dir)
      if (atOrUnder(d, oldPath)) meta.dir = newPath + d.slice(oldPath.length)
    }
    await writeIndex()
  }

  const remove = async (dir, names) => {
    bump()
    const at = normDir(dir)
    const blobs = []
    for (const name of names) {
      const id = idAt(at, name)
      if (id) {
        blobs.push(id)
        delete open.index.files[id]
        continue
      }
      const path = childDir(at, name)
      if (!open.index.dirs[path]) continue
      for (const p of Object.keys(open.index.dirs)) {
        if (atOrUnder(p, path)) delete open.index.dirs[p]
      }
      for (const [fid, meta] of Object.entries(open.index.files)) {
        if (!atOrUnder(normDir(meta.dir), path)) continue
        blobs.push(fid)
        delete open.index.files[fid]
      }
    }
    // The index is the source of truth, so drop it first; a stray blob is inert either way.
    await writeIndex()
    for (const id of blobs) await deleteFile(open.path, id).catch(() => {})
  }

  // Returns how many moved; a name already taken at the destination is skipped, not overwritten.
  const move = async (dir, names, destDir) => {
    bump()
    const at = normDir(dir)
    const dest = normDir(destDir)
    if (dest === at) return 0
    const taken = takenIn(dest)
    let moved = 0
    for (const name of names) {
      if (taken.has(name)) continue
      const id = idAt(at, name)
      if (id) {
        open.index.files[id].dir = dest
        taken.add(name)
        moved++
        continue
      }
      const path = childDir(at, name)
      if (!open.index.dirs[path]) continue
      // A folder can't be dropped inside itself; the subtree would lose its way to the root.
      if (atOrUnder(dest, path)) continue
      const to = childDir(dest, name)
      for (const p of Object.keys(open.index.dirs)) {
        if (!atOrUnder(p, path)) continue
        open.index.dirs[to + p.slice(path.length)] = open.index.dirs[p]
        delete open.index.dirs[p]
      }
      for (const meta of Object.values(open.index.files)) {
        const d = normDir(meta.dir)
        if (atOrUnder(d, path)) meta.dir = to + d.slice(path.length)
      }
      taken.add(name)
      moved++
    }
    if (moved) await writeIndex()
    return moved
  }

  // ── Recovery doc ────────────────────────────────────────────────────────────

  const recoveryDoc = () => `# Recovering this vault without SimpleDrive

The files in this folder are encrypted with [age](https://age-encryption.org), a small,
documented format with independent implementations in Go and Rust. You do not need
SimpleDrive, or any code from it, to get your files back — only the \`age\` command and
the password (or the recovery code printed when this vault was made).

Keep this file with the folder. Everything below can be run from a terminal on macOS,
Linux or Windows.

## 1. Install age

    brew install age                   # macOS
    sudo apt install age               # Debian/Ubuntu
    winget install FiloSottile.age     # Windows

## 2. Unwrap the vault key

Open a terminal in this folder (Terminal on macOS/Linux, PowerShell on Windows) and run:

    age -d -o vault.key ${KEY_FILE}

It will prompt for your password. If you have lost the password but kept the recovery
code, use that instead — both files hold the same key:

    age -d -o vault.key ${RECOVERY_FILE}

Delete \`vault.key\` when you are finished.

Every command here writes with \`-o\` rather than \`>\`, because PowerShell re-encodes what
it redirects, which would corrupt any file that isn't plain text.

## 3. Read the index

    age -d -i vault.key ${INDEX_FILE}

This prints JSON mapping each blob name in this folder to its real filename and the
folder it belongs to. \`"dir"\` is a path inside the vault; \`"/"\` is the vault's top level.

    {"v":2,
     "files":{"9f2c...":{"name":"2023-return.pdf","dir":"/Taxes","size":81234}},
     "dirs":{"/Taxes":{}}}

Folders exist only in this index — every file sits directly in this one folder, so that
folder names are encrypted too.

## 4. Decrypt one file

    age -d -i vault.key -o 2023-return.pdf 9f2c...

## 5. Decrypt everything, keeping the folders

macOS or Linux, with \`jq\` installed:

    age -d -i vault.key ${INDEX_FILE} |
      jq -r '.files | to_entries[] | "\\(.key)\\t\\(.value.dir)\\t\\(.value.name)"' |
      while IFS=$'\\t' read -r id dir name; do
        mkdir -p "recovered$dir"
        age -d -i vault.key -o "recovered$dir/$name" "$id"
      done

Windows PowerShell, no extra tools needed:

    $index = age -d -i vault.key ${INDEX_FILE} | ConvertFrom-Json
    foreach ($f in $index.files.PSObject.Properties) {
      $dir = "recovered" + $f.Value.dir.TrimEnd("/")
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      age -d -i vault.key -o "$dir/$($f.Value.name)" $f.Name
    }

## If the index is lost

The blobs are still readable — you just will not know their names. Decrypt them and
identify each one by its contents:

    age -d -i vault.key -o recovered.bin 9f2c... && file recovered.bin

On Windows, decrypt to \`recovered.bin\` and open it to see what it is.

## What is not hidden

File contents, filenames and folder names are encrypted. The number of files, their
approximate sizes, and their modification times are visible to anyone holding this folder.
`

  return {
    covers,
    openPath,
    lock,
    setAutoLockHandler,
    create,
    unlock,
    changePassphrase,
    list,
    hasDir,
    mkdir,
    addFile,
    addBytes,
    readFile,
    writeFile,
    rename,
    remove,
    move,
    idAt,
    RESERVED,
    KEY_FILE,
  }
})()
