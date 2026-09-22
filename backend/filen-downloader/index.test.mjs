import assert from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  downloadFolderLink,
  downloadSingleFile,
  exceedsSizeLimit,
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

for (const kind of ["file", "folder"]) {
  test(`${kind} links reuse deduplicated audio and recover when it goes missing`, async t => {
    const outDir = await temporaryDirectory(t)
    const canonicalDir = await temporaryDirectory(t)
    const canonical = path.join(canonicalDir, "canonical.mp3")
    // Same audio can have a different total size because of tags.
    await writeFile(canonical, "audio with different tags")
    const retained = {
      "song.mp3": { path: canonical, size: 5, fileSize: 25 }
    }
    let downloads = 0
    const cloud = {
      async filePublicLinkInfo() {
        return { name: "song.mp3", size: 5, uuid: "file-id" }
      },
      async directoryPublicLinkInfo() {
        return { metadata: { name: "Album" }, parent: "root" }
      },
      async directoryPublicLinkContent() {
        return {
          files: [{ uuid: "file-id", size: 5, metadata: { name: "song.mp3", key: "key" } }],
          folders: []
        }
      },
      async downloadFileToLocal({ to }) {
        downloads++
        await writeFile(to, "audio")
      }
    }
    const download = kind === "file" ? downloadSingleFile : downloadFolderLink
    for (let i = 0; i < 2; i++) {
      await download(cloud, "link", "key", "", outDir, retained)
    }
    assert.equal(downloads, 0)
    assert.deepEqual(await readdir(outDir), [])
    await rm(canonical)
    await download(cloud, "link", "key", "", outDir, retained)
    assert.equal(downloads, 1)
  })
}

for (const scenario of ["changed source size", "empty canonical", "truncated canonical", "directory canonical"]) {
  test(`does not reuse a retained file with ${scenario}`, async t => {
    const outDir = await temporaryDirectory(t)
    const canonicalDir = await temporaryDirectory(t)
    let canonical = path.join(canonicalDir, "canonical.mp3")
    await writeFile(canonical, scenario === "empty canonical" ? "" : "audio")
    if (scenario === "directory canonical") canonical = canonicalDir
    const retained = {
      "song.mp3": {
        path: canonical,
        size: scenario === "changed source size" ? 10 : 5,
        fileSize: scenario === "truncated canonical" ? 10 : 5
      }
    }
    let downloads = 0
    const cloud = {
      async filePublicLinkInfo() { return { name: "song.mp3", size: 5, uuid: "file-id" } },
      async downloadFileToLocal({ to }) { downloads++; await writeFile(to, "audio") }
    }
    await downloadSingleFile(cloud, "link", "key", "", outDir, retained)
    assert.equal(downloads, 1)
  })
}

test("exceedsSizeLimit rejects oversized declared sizes and chunk counts", () => {
  const MiB = 1024 * 1024
  assert.equal(exceedsSizeLimit(10 * MiB, 10, 100 * MiB), false)
  assert.equal(exceedsSizeLimit(101 * MiB, 101, 100 * MiB), true)
  // A small declared size cannot hide a huge chunk count.
  assert.equal(exceedsSizeLimit(1 * MiB, 5000, 100 * MiB), true)
  assert.equal(exceedsSizeLimit("not a number", 1, 100 * MiB), true)
})
