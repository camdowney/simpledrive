"use strict"

// Stamped with the build's asset fingerprint as the worker is served, so a rebuild carries nothing
// over: new worker, new cache names.
const VERSION = "__SD_VERSION__"

const SHELL = `sd-shell-${VERSION}`
const DATA = `sd-data-${VERSION}`
// Unversioned: files handed over by a share sheet have to survive an update mid-hand-off.
const SHARE = "sd-share"

// Fetched on every cold load anyway, so precaching costs nothing and the app opens instantly.
const SHELL_URLS = [
  "/",
  "/static/css/style.css",
  "/static/js/boot.js",
  "/static/js/app.js",
  "/static/js/vault.js",
  "/static/js/vault-worker.js",
  "/static/favicon.svg",
  "/static/manifest.json",
  "/static/vendor/toastui-editor.min.css",
  "/static/vendor/tui-color-picker.min.css",
  "/static/vendor/toastui-editor-plugin-color-syntax.min.css",
  "/static/vendor/toastui-editor-all.min.js",
  "/static/vendor/tui-color-picker.min.js",
  "/static/vendor/toastui-editor-plugin-color-syntax.min.js",
  "/static/vendor/age.min.js",
]

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches
      .open(SHELL)
      // One failed asset must not fail the install, or a single 404 leaves the app uncached.
      .then((c) => Promise.allSettled(SHELL_URLS.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names.map((n) => (n === SHELL || n === DATA || n === SHARE ? null : caches.delete(n)))
        )
      )
      .then(() => self.clients.claim())
  )
})

self.addEventListener("message", (e) => {
  // Listings cached on this device belong to the session that fetched them, and end with it.
  if (e.data?.type === "clear-data") e.waitUntil(caches.delete(DATA))
})

// ─── Share target ─────────────────────────────────────────────────────────────

// Parked in a cache and answered with a redirect: a share target may not render its own page.
const takeSharedFiles = async (request) => {
  try {
    const form = await request.formData()
    const files = form.getAll("files").filter((f) => f && f.name)
    const cache = await caches.open(SHARE)
    for (const key of await cache.keys()) await cache.delete(key)
    let i = 0
    for (const file of files) {
      await cache.put(
        new Request(`/__shared/${i++}`),
        new Response(file, {
          headers: {
            "content-type": file.type || "application/octet-stream",
            "x-name": encodeURIComponent(file.name),
            "x-modified": String(file.lastModified || 0),
          },
        })
      )
    }
  } catch {}
  return Response.redirect("/?shared=1", 303)
}

// ─── Fetch ────────────────────────────────────────────────────────────────────

// A share link's visitor must leave nothing of the folder behind on this device.
const cacheableClient = async (id) => {
  if (!id) return false
  const client = await self.clients.get(id)
  if (!client) return false
  return !new URL(client.url).pathname.startsWith("/s/")
}

const networkFirst = async (event) => {
  try {
    const res = await fetch(event.request)
    if (res.ok && (await cacheableClient(event.clientId))) {
      const copy = res.clone()
      caches.open(DATA).then((c) => c.put(event.request, copy))
    }
    return res
  } catch (err) {
    const hit = await caches.match(event.request)
    if (hit) {
      // The app reads this back and says so, rather than passing stale rows off as current.
      const headers = new Headers(hit.headers)
      headers.set("x-from-cache", "1")
      return new Response(hit.body, { status: hit.status, headers })
    }
    throw err
  }
}

const cacheFirst = async (request) => {
  const hit = await caches.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok) {
    const copy = res.clone()
    caches.open(SHELL).then((c) => c.put(request, copy))
  }
  return res
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin) return

  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(takeSharedFiles(event.request))
    return
  }
  if (event.request.method !== "GET") return

  // A share link's entry sets a cookie on the way through, so it can never be answered locally.
  if (event.request.mode === "navigate") {
    if (url.pathname === "/") event.respondWith(cacheFirst(new Request("/")))
    return
  }
  // Only the listing is worth having offline; thumbnails and media would fill the disk for it.
  if (url.pathname === "/api/files") {
    event.respondWith(networkFirst(event))
    return
  }
  if (url.pathname.startsWith("/static/")) {
    event.respondWith(cacheFirst(event.request))
  }
})
