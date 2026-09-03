import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  downloadFolderLink,
  downloadSingleFile,
  parseShareUrl
} from "./index.mjs"

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "lumen-filen-test-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test("parses the public-link id and fragment key", () => {
  assert.deepEqual(
    parseShareUrl("https://drive.filen.io/d/folder-id%23secret-key"),
    { uuid: "folder-id", key: "secret-key", typeHint: "d" }
  )
})

test("authenticates a file link, validates bytes, and reuses a complete download", async t => {
  const outDir = await temporaryDirectory(t)
  let downloads = 0
  const cloud = {
    async filePublicLinkInfo(input) {
      assert.equal(input.password, "link-password")
      return {
        name: "song.mp3",
        size: 5,
        uuid: "file-id",
        bucket: "bucket",
        region: "region",
        chunks: 1,
        version: 2
      }
    },
    async downloadFileToLocal({ to }) {
      downloads += 1
      await writeFile(to, "audio")
    }
  }

  await downloadSingleFile(cloud, "link-id", "link-key", "link-password", outDir)
  await downloadSingleFile(cloud, "link-id", "link-key", "link-password", outDir)

  assert.equal(downloads, 1)
  assert.equal(await readFile(path.join(outDir, "song.mp3"), "utf8"), "audio")
})

test("lists an authenticated folder and downloads its supported files", async t => {
  const outDir = await temporaryDirectory(t)
  const cloud = {
    async directoryPublicLinkInfo() {
      return {
        hasPassword: true,
        metadata: { name: "Album" },
        salt: "salt",
        parent: "root"
      }
    },
    async directoryPublicLinkContent(input) {
      assert.equal(input.password, "link-password")
      assert.equal(input.salt, "salt")
      return {
        files: [{
          uuid: "track-id",
          bucket: "bucket",
          region: "region",
          chunks: 1,
          version: 2,
          size: 5,
          metadata: { name: "track.flac", key: "file-key" }
        }],
        folders: []
      }
    },
    async downloadFileToLocal({ to }) {
      await writeFile(to, "audio")
    }
  }

  await downloadFolderLink(cloud, "link-id", "link-key", "link-password", outDir)

  assert.equal(
    await readFile(path.join(outDir, "Album", "track.flac"), "utf8"),
    "audio"
  )
})

test("rejects truncated downloads and removes partial files", async t => {
  const outDir = await temporaryDirectory(t)
  const cloud = {
    async filePublicLinkInfo() {
      return {
        name: "broken.mp3",
        size: 10,
        uuid: "file-id",
        bucket: "bucket",
        region: "region",
        chunks: 1,
        version: 2
      }
    },
    async downloadFileToLocal({ to }) {
      await writeFile(to, "short")
    }
  }

  await assert.rejects(
    downloadSingleFile(cloud, "link-id", "link-key", "", outDir),
    /download size mismatch/
  )
  assert.deepEqual(await readdir(outDir), [])
})
