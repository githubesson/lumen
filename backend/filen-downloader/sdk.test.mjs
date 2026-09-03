import assert from "node:assert/strict"
import test from "node:test"
import { FilenSDK } from "@filen/sdk"

test("the pinned Filen SDK exposes the public-link API used by the downloader", () => {
  const sdk = new FilenSDK({
    email: "anonymous",
    password: "anonymous",
    apiKey: "anonymous",
    masterKeys: ["anonymous"],
    publicKey: "anonymous",
    privateKey: "anonymous",
    baseFolderUUID: "anonymous",
    authVersion: 2,
    userId: 1,
    connectToSocket: false,
  })
  const cloud = sdk.cloud()
  assert.equal(typeof cloud.filePublicLinkInfo, "function")
  assert.equal(typeof cloud.directoryPublicLinkInfo, "function")
  assert.equal(typeof cloud.directoryPublicLinkContent, "function")
  assert.equal(typeof cloud.downloadFileToLocal, "function")
})
