import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"

import {
  downloadFolderLink,
  downloadSingleFile,
  downloadWithTimeout,
  exceedsSizeLimit,
  parseShareUrl,
  removeStaleParts
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

test("a download past the per-file timeout is aborted and its temp file removed", async t => {
  const outDir = await temporaryDirectory(t)
  let aborted = false
  const cloud = {
    async filePublicLinkInfo() {
      return { name: "slow.mp3", size: 5, uuid: "file-id", chunks: 1 }
    },
    async downloadFileToLocal({ to, abortSignal }) {
      await writeFile(to, "par")
      await new Promise((_, reject) => abortSignal.addEventListener("abort", () => {
        aborted = true
        reject(new Error("Aborted"))
      }))
    }
  }
  // A 50ms limit in place of FILEN_FILE_TIMEOUT_MS, which is read at load.
  const slow = {
    ...cloud,
    downloadFileToLocal: params => downloadWithTimeout(cloud, params, 50)
  }
  await assert.rejects(downloadSingleFile(slow, "link", "key", "", outDir), /timed out/)
  assert.equal(aborted, true)
  assert.deepEqual(await readdir(outDir), [])
})

test("removeStaleParts deletes only old temp files of that target", async t => {
  const dir = await temporaryDirectory(t)
  const target = path.join(dir, "song.mp3")
  const old = path.join(dir, ".song.mp3.0b6e7c9a-3a63-4f1e-9a52-0d2f1d3b8c11.part")
  // Downloaded as song-2.mp3 because song.mp3 was taken then.
  const renamed = path.join(dir, ".song-2.mp3.3b6e7c9a-3a63-4f1e-9a52-0d2f1d3b8c11.part")
  const fresh = path.join(dir, ".song.mp3.1b6e7c9a-3a63-4f1e-9a52-0d2f1d3b8c11.part")
  const other = path.join(dir, ".other.mp3.2b6e7c9a-3a63-4f1e-9a52-0d2f1d3b8c11.part")
  const similar = path.join(dir, ".song-live.mp3.4b6e7c9a-3a63-4f1e-9a52-0d2f1d3b8c11.part")
  const tracker = path.join(dir, ".song.mp3.123456789.part")
  for (const p of [old, renamed, fresh, other, similar, tracker]) await writeFile(p, "x")
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000)
  for (const p of [old, renamed, other, similar, tracker]) await utimes(p, hourAgo, hourAgo)
  await removeStaleParts(target, 60 * 1000)
  assert.deepEqual(
    (await readdir(dir)).sort(),
    [tracker, other, similar, fresh].map(p => path.basename(p)).sort()
  )
})

test("a download moved to a free name still clears temp files left under the name it was for", async t => {
  const outDir = await temporaryDirectory(t)
  // A run killed mid-download left this; another file took song.mp3 since.
  const stale = path.join(outDir, ".song.mp3.0b6e7c9a-3a63-4f1e-9a52-0d2f1d3b8c11.part")
  await writeFile(stale, "par")
  const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  await utimes(stale, longAgo, longAgo)
  await writeFile(path.join(outDir, "song.mp3"), "other release")
  const cloud = {
    async filePublicLinkInfo() {
      return { name: "song.mp3", size: 5, uuid: "file-id", chunks: 1 }
    },
    async downloadFileToLocal({ to }) {
      await writeFile(to, "audio")
    }
  }
  await downloadSingleFile(cloud, "link", "key", "", outDir)
  assert.deepEqual((await readdir(outDir)).sort(), ["song-1.mp3", "song.mp3"])
  assert.equal(await readFile(path.join(outDir, "song-1.mp3"), "utf8"), "audio")
})

test("SIGTERM removes the partial download before the helper exits", async t => {
  const outDir = await temporaryDirectory(t)
  const scriptDir = await temporaryDirectory(t)
  const helper = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "index.mjs")).href
  const script = path.join(scriptDir, "stuck.mjs")
  await writeFile(script, `
import { writeFile } from "node:fs/promises"
import { downloadSingleFile, exitCleanlyOnSignals } from ${JSON.stringify(helper)}
exitCleanlyOnSignals()
const cloud = {
  async filePublicLinkInfo() { return { name: "song.mp3", size: 5, uuid: "file-id", chunks: 1 } },
  async downloadFileToLocal({ to }) {
    await writeFile(to, "par")
    console.log("started")
    await new Promise(() => setInterval(() => {}, 1000))
  }
}
await downloadSingleFile(cloud, "link", "key", "", process.argv[2])
`)
  const child = spawn(process.execPath, [script, outDir], { stdio: ["ignore", "pipe", "inherit"] })
  const exited = new Promise(resolve => child.on("exit", (code, signal) => resolve({ code, signal })))
  await new Promise((resolve, reject) => {
    child.stdout.on("data", chunk => {
      if (String(chunk).includes("started")) resolve()
    })
    child.on("exit", () => reject(new Error("helper exited before the download started")))
  })
  assert.equal((await readdir(outDir)).length, 1)
  child.kill("SIGTERM")
  assert.deepEqual(await exited, { code: 143, signal: null })
  assert.deepEqual(await readdir(outDir), [])
})
