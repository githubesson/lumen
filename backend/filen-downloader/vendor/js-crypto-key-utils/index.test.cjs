"use strict"

const assert = require("node:assert/strict")
const { createPrivateKey, createPublicKey, generateKeyPairSync } = require("node:crypto")
const test = require("node:test")
const { Key } = require("./index.cjs")

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 })

test("converts SPKI DER public keys to PEM without changing the key", async () => {
  const der = pair.publicKey.export({ format: "der", type: "spki" })
  const pem = await new Key("der", der).export("pem")
  assert.equal(
    createPublicKey(pem).export({ format: "der", type: "spki" }).toString("hex"),
    der.toString("hex"),
  )
})

test("converts PKCS8 DER private keys to PEM without changing the key", async () => {
  const der = pair.privateKey.export({ format: "der", type: "pkcs8" })
  const pem = await new Key("der", der).export("pem")
  assert.equal(
    createPrivateKey(pem).export({ format: "der", type: "pkcs8" }).toString("hex"),
    der.toString("hex"),
  )
})

test("round-trips public JWK values", async () => {
  const jwk = pair.publicKey.export({ format: "jwk" })
  assert.deepEqual(await new Key("jwk", jwk).export("jwk"), jwk)
})
