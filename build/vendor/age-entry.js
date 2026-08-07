// Source for web/static/vendor/age.min.js. Rebuild with: pnpm run vendor:age
import { Encrypter, Decrypter, generateIdentity, identityToRecipient } from "age-encryption"
// The package's "exports" field hides this path, so it is reached through node_modules
// directly; esbuild resolves it to the same module instance the index already imports.
import { forceWebCryptoOff } from "../../node_modules/age-encryption/dist/x25519.js"

// crypto.subtle is undefined outside a secure context, and the library's own fallback only
// catches ReferenceError, so a bare-IP HTTP host needs the pure-JS path selected up front.
if (typeof crypto === "undefined" || !crypto.subtle) forceWebCryptoOff(true)

export { Encrypter, Decrypter, generateIdentity, identityToRecipient }
