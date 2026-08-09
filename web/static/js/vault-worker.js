// age works a whole file in one uninterruptible call — ~10s for 300 MB — so it runs off the page.
importScripts("/static/vendor/age.min.js")

const run = async ({ op, recipient, identity, passphrase, bytes }) => {
  if (op === "encrypt" || op === "encryptPassphrase") {
    const enc = new age.Encrypter()
    if (op === "encrypt") enc.addRecipient(recipient)
    else enc.setPassphrase(passphrase)
    return await enc.encrypt(bytes)
  }
  const dec = new age.Decrypter()
  if (op === "decrypt") dec.addIdentity(identity)
  else dec.addPassphrase(passphrase)
  return await dec.decrypt(bytes)
}

// Answered before any work is sent, so a page whose worker never loads can fall back to itself.
self.postMessage({ ready: true })

self.onmessage = async ({ data }) => {
  try {
    const out = await run(data)
    self.postMessage({ id: data.id, out }, [out.buffer])
  } catch (e) {
    self.postMessage({ id: data.id, error: String((e && e.message) || e) })
  }
}
