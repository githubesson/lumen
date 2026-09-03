"use strict"

const { createPrivateKey, createPublicKey } = require("node:crypto")

function importDer(key) {
  const bytes = Buffer.from(key)
  try {
    return { key: createPublicKey({ key: bytes, format: "der", type: "spki" }), private: false }
  } catch (publicError) {
    try {
      return { key: createPrivateKey({ key: bytes, format: "der", type: "pkcs8" }), private: true }
    } catch (privateError) {
      privateError.cause = publicError
      throw privateError
    }
  }
}

function importPem(key) {
  try {
    return { key: createPublicKey(key), private: false }
  } catch (publicError) {
    try {
      return { key: createPrivateKey(key), private: true }
    } catch (privateError) {
      privateError.cause = publicError
      throw privateError
    }
  }
}

function importJwk(key) {
  if (!key || typeof key !== "object") throw new TypeError("JWK must be an object")
  return key.d
    ? { key: createPrivateKey({ key, format: "jwk" }), private: true }
    : { key: createPublicKey({ key, format: "jwk" }), private: false }
}

class Key {
  constructor(format, key) {
    const imported =
      format === "der"
        ? importDer(key)
        : format === "pem"
          ? importPem(key)
          : format === "jwk"
            ? importJwk(key)
            : null
    if (!imported) throw new Error(`Unsupported key format: ${format}`)
    this.keyObject = imported.key
    this.private = imported.private
  }

  async export(format = "jwk", options = {}) {
    if (format === "jwk") return this.keyObject.export({ format: "jwk" })
    const type = this.private ? "pkcs8" : "spki"
    if (format === "der") return this.keyObject.export({ format: "der", type })
    if (format === "pem") {
      return this.keyObject.export({
        format: "pem",
        type,
        ...(options.encryptParams ?? {}),
      })
    }
    throw new Error(`Unsupported key export format: ${format}`)
  }

  get isPrivate() {
    return this.private
  }

  get keyType() {
    return Promise.resolve(this.keyObject.asymmetricKeyType === "rsa" ? "RSA" : "EC")
  }
}

module.exports = { Key }
