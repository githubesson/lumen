#!/usr/bin/env node
import { FilenSDK } from "@filen/sdk"
import path from "node:path"
import fs from "node:fs/promises"

function usage() {
  console.error("Usage: node index.mjs [--json] [--password <pw> | --password-env <name>] <filen-share-url> <outDir>")
  process.exit(1)
}

function parseArgs(argv) {
  const args = { json: false, password: "", passwordEnv: "", url: "", outDir: "" }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--json") args.json = true
    else if (a === "--password" || a === "-p") args.password = argv[++i] ?? ""
    else if (a === "--password-env") args.passwordEnv = argv[++i] ?? ""
    else if (a === "-h" || a === "--help") usage()
    else rest.push(a)
  }
  if (rest.length < 2) usage()
  args.url = rest[0]
  args.outDir = rest[1]
  if (args.passwordEnv) args.password = process.env[args.passwordEnv] ?? ""
  return args
}

function emit(obj) {
  console.log(JSON.stringify(obj))
}

function allowedExtensions() {
  const raw =
    process.env.FILEN_ALLOWED_EXTENSIONS ??
    ".aac,.flac,.m4a,.mp3,.mp4,.ogg,.opus,.wav,.webm"
  return new Set(
    raw
      .split(",")
      .map(ext => ext.trim().toLowerCase())
      .filter(Boolean)
      .map(ext => (ext.startsWith(".") ? ext : `.${ext}`))
  )
}

const ALLOWED_EXTENSIONS = allowedExtensions()

function isAllowedFile(name) {
  return ALLOWED_EXTENSIONS.has(path.extname(name).toLowerCase())
}

function parseShareUrl(raw) {
  const decoded = raw.replace(/%23/gi, "#")
  const m = decoded.match(/\/([fd])\/([A-Za-z0-9-]+)(?:#([^\s?&]+))?/)
  if (!m) throw new Error("Couldn't find /f/<uuid> or /d/<uuid> in URL")
  const typeHint = m[1]
  const uuid = m[2]
  let key = m[3] ?? ""
  try {
    key = decodeURIComponent(key)
  } catch {
    /* leave as-is */
  }
  if (!key) throw new Error("Couldn't extract #key fragment from URL")
  if (/^[0-9a-f]+$/i.test(key) && key.length % 2 === 0 && key.length >= 32) {
    const buf = Buffer.from(key, "hex")
    const ascii = buf.toString("ascii")
    if (/^[\x20-\x7e]+$/.test(ascii)) key = ascii
  }
  return { uuid, key, typeHint }
}

function sanitizeSegment(name) {
  const sanitized = String(name ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .slice(0, 200)
  if (!sanitized || sanitized === "." || sanitized === "..") return "unnamed"
  return sanitized
}

function resolveInside(root, target) {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const rel = path.relative(resolvedRoot, resolvedTarget)
  if (rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))) {
    return resolvedTarget
  }
  throw new Error("target path escapes output directory")
}

function joinInside(root, ...segments) {
  return resolveInside(root, path.join(root, ...segments))
}

function anonymousSdk() {
  return new FilenSDK({
    email: "anonymous",
    password: "anonymous",
    apiKey: "anonymous",
    masterKeys: ["anonymous"],
    publicKey: "anonymous",
    privateKey: "anonymous",
    baseFolderUUID: "anonymous",
    authVersion: 2,
    userId: 1,
    connectToSocket: false
  })
}

async function statOrNull(p) {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

async function nextAvailablePath(outDir, target) {
  if (!(await statOrNull(target))) return target
  const ext = path.extname(target)
  const base = target.slice(0, target.length - ext.length)
  for (let i = 1; i < 10000; i++) {
    const cand = resolveInside(outDir, `${base}-${i}${ext}`)
    if (!(await statOrNull(cand))) return cand
  }
  return resolveInside(outDir, `${base}-${Date.now()}${ext}`)
}

async function prepareTarget(outDir, target, size) {
  target = resolveInside(outDir, target)
  const st = await statOrNull(target)
  if (!st) return { status: "downloaded", path: target }
  if (st.isFile() && st.size === size && st.size > 0) {
    return { status: "existing", path: target }
  }
  return { status: "downloaded", path: await nextAvailablePath(outDir, target) }
}

function readOnlyError(err) {
  const msg = String(err?.message ?? err).toLowerCase()
  return err?.code === "EROFS" || err?.code === "EACCES" || msg.includes("read-only file system")
}

async function downloadSingleFile(cloud, linkUuid, linkKey, password, outDir) {
  let info
  try {
    info = await cloud.filePublicLinkInfo({
      uuid: linkUuid,
      key: linkKey,
      password: password || undefined,
      salt: undefined
    })
  } catch (err) {
    if (/password/i.test(err.message ?? "")) {
      throw new Error("password required or invalid")
    }
    throw err
  }
  const relPath = info.name
  const initial = joinInside(outDir, sanitizeSegment(info.name))
  if (!isAllowedFile(relPath)) {
    emit({
      event: "file",
      status: "skipped",
      relPath,
      path: initial,
      size: info.size,
      error: "unsupported file extension"
    })
    return
  }
  const target = await prepareTarget(outDir, initial, info.size)
  if (target.status === "existing") {
    emit({ event: "file", status: "existing", relPath, path: target.path, size: info.size })
    return
  }
  try {
    await fs.mkdir(path.dirname(target.path), { recursive: true })
    await cloud.downloadFileToLocal({
      uuid: info.uuid,
      bucket: info.bucket,
      region: info.region,
      chunks: info.chunks,
      version: info.version,
      key: linkKey,
      size: info.size,
      to: target.path
    })
    emit({ event: "file", status: "downloaded", relPath, path: target.path, size: info.size })
  } catch (err) {
    if (readOnlyError(err)) {
      emit({
        event: "file",
        status: "skipped",
        relPath,
        path: target.path,
        size: info.size,
        error: "destination is read-only"
      })
      return
    }
    emit({
      event: "file",
      status: "failed",
      relPath,
      path: target.path,
      size: info.size,
      error: String(err?.message ?? err)
    })
    throw err
  }
}

async function walkFolder(cloud, linkUuid, linkKey, password, salt, folderUuid, outDir, localDir, relPath, jobs) {
  const content = await cloud.directoryPublicLinkContent({
    uuid: linkUuid,
    parent: folderUuid,
    key: linkKey,
    password: password || undefined,
    salt: salt ?? undefined
  })
  for (const file of content.files) {
    const name = file.metadata?.name ?? `file_${file.uuid}`
    const childRel = relPath ? `${relPath}/${name}` : name
    jobs.push({
      relPath: childRel,
      localPath: resolveInside(outDir, path.join(localDir, sanitizeSegment(name))),
      size: file.size,
      params: {
        uuid: file.uuid,
        bucket: file.bucket,
        region: file.region,
        chunks: file.chunks,
        version: file.version,
        key: file.metadata.key,
        size: file.size
      }
    })
  }
  await Promise.all(
    content.folders.map(async folder => {
      const name = folder.metadata?.name ?? `folder_${folder.uuid}`
      await walkFolder(
        cloud,
        linkUuid,
        linkKey,
        password,
        salt,
        folder.uuid,
        outDir,
        resolveInside(outDir, path.join(localDir, sanitizeSegment(name))),
        relPath ? `${relPath}/${name}` : name,
        jobs
      )
    })
  )
}

async function downloadFolderLink(cloud, linkUuid, linkKey, password, outDir) {
  let info
  try {
    info = await cloud.directoryPublicLinkInfo({ uuid: linkUuid, key: linkKey })
  } catch (err) {
    throw new Error(`Couldn't read folder link info: ${err.message ?? err}`)
  }
  if (info.hasPassword && !password) {
    throw new Error("password required")
  }
  const rootName = info.metadata?.name ?? `filen_${linkUuid}`
  const rootLocal = joinInside(outDir, sanitizeSegment(rootName))
  const jobs = []
  await walkFolder(cloud, linkUuid, linkKey, password, info.salt, info.parent, outDir, rootLocal, "", jobs)
  let failed = 0
  for (const job of jobs) {
    if (!isAllowedFile(job.relPath)) {
      emit({
        event: "file",
        status: "skipped",
        relPath: job.relPath,
        path: job.localPath,
        size: job.size,
        error: "unsupported file extension"
      })
      continue
    }
    const target = await prepareTarget(outDir, job.localPath, job.size)
    if (target.status === "existing") {
      emit({ event: "file", status: "existing", relPath: job.relPath, path: target.path, size: job.size })
      continue
    }
    try {
      await fs.mkdir(path.dirname(target.path), { recursive: true })
      await cloud.downloadFileToLocal({ ...job.params, to: target.path })
      emit({ event: "file", status: "downloaded", relPath: job.relPath, path: target.path, size: job.size })
    } catch (err) {
      if (readOnlyError(err)) {
        emit({
          event: "file",
          status: "skipped",
          relPath: job.relPath,
          path: target.path,
          size: job.size,
          error: "destination is read-only"
        })
        continue
      }
      failed++
      emit({
        event: "file",
        status: "failed",
        relPath: job.relPath,
        path: target.path,
        size: job.size,
        error: String(err?.message ?? err)
      })
    }
  }
  if (failed > 0) throw new Error(`${failed} file(s) failed`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const { uuid, key, typeHint } = parseShareUrl(args.url)
  const sdk = anonymousSdk()
  const cloud = sdk.cloud()
  const outDir = path.resolve(args.outDir)
  const tryFolder = () => downloadFolderLink(cloud, uuid, key, args.password, outDir)
  const tryFile = () => downloadSingleFile(cloud, uuid, key, args.password, outDir)
  const [first, second] = typeHint === "d" ? [tryFile, tryFolder] : [tryFolder, tryFile]
  let firstErr
  try {
    await first()
    return
  } catch (err) {
    firstErr = err
  }
  try {
    await second()
  } catch (err2) {
    throw new Error(`Could not download as folder or file. First: ${firstErr?.message ?? firstErr}; second: ${err2?.message ?? err2}`)
  }
}

main().catch(err => {
  console.error(err.stack ?? err.message ?? err)
  process.exit(1)
})
