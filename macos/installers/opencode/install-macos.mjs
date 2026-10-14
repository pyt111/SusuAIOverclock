#!/usr/bin/env node
/**
 * SHIYI 破甲包 · OpenCode Desktop（macOS）安装器
 * = install.ps1 + patch-opencoe.js + merge-config.mjs 的 macOS 单文件移植（纯 Node ≥18，零依赖）
 *
 * 做三件事（与 Windows 侧等价）：
 *   1) 合并 opencode.jsonc 到用户配置目录（幂等；覆盖前先留 .bak-install 备份）
 *   2) 部署 plugins/（shiyi-lock.ts / shiyi-lock.mjs）与 AGENTS.md / shield-protocol.md
 *   3) 给 OpenCode.app 的 app.asar 打补丁（P1-P7：更新器禁用 / 权限默认放行 / 工具不隐藏 / 内置提示清空）
 *      —— 原生解析 asar：解 header → 内存替换目标文件 → 重算每文件 integrity → 原子写回 → 逐文件校验
 *
 * 安全说明：
 *   - 默认目标 /Applications/OpenCode.app；测试请用 --asar 指向 /private/tmp 下的副本。
 *   - 修改 asar 会破坏 macOS 代码签名；当 asar 位于 .app 内时本脚本自动 ad-hoc 重签（--no-sign 关闭）。
 *   - asar 备份：<asar>.orig-backup.bak（已存在则不重复备份）；回滚：--uninstall。
 *
 * 用法见 --help。CLI 参数：--pack / --app / --asar / --config-dir / --uninstall / --dry-run / --help
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import crypto from "node:crypto"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const INSTALLER_VERSION = "1.0.0"

const PROMO_LINKS = [
  ["QQ 群", "https://qm.qq.com/q/annVoopmvY"],
  ["官网", "https://susu.wiki"],
]

const DEFAULT_APP_CANDIDATES = [
  "/Applications/OpenCode.app",
  path.join(os.homedir(), "Applications", "OpenCode.app"),
]

// pack 目录必需文件（安装模式）
const REQUIRED_PACK_FILES = [
  "opencode.jsonc",
  "plugins/shiyi-lock.ts",
  "plugins/shiyi-lock.mjs",
  "AGENTS.md",
  "shield-protocol.md",
]

// 部署清单（pack 内路径 == 配置目录内相对路径）
const PAYLOAD_FILES = [
  "plugins/shiyi-lock.ts",
  "plugins/shiyi-lock.mjs",
  "AGENTS.md",
  "shield-protocol.md",
]

const CONFIG_PACKAGE_JSON = '{"type":"module","dependencies":{}}'
const PLUGIN_DEFAULT = "./plugins/shiyi-lock.ts"
const BACKUP_SUFFIX = ".orig-backup.bak"
const CONFIG_BACKUP_SUFFIX = ".bak-install"
const ASAR_INTEGRITY_BLOCK_SIZE = 4194304

// core chunk 定位标记（与 patch-opencoe.js 一致，另加 V2 标记）
const CHUNK_MARKERS = [
  "function evaluate3(",
  "function disabled(",
  "function provider9(",
  'action: "ask"',
  "default_default",
  "function evaluate2(",
  "function denied(input, rules)",
]

// ── 补丁定义 ──────────────────────────────────────────────────────────────
// variants：同一逻辑补丁的不同版本形态（先试 macOS 1.16.x 形态，再试 Windows 1.18.x 形态）。
// 每条 from 必须在文本中唯一命中（count===1），否则拒绝打补丁（fail-closed）。
const BASE_PATCHES = [
  {
    id: "P1",
    file: "index",
    desc: "更新器禁用 (prod→dev)",
    variants: [['const raw = "prod"', 'const raw = "dev"']],
  },
  {
    id: "P2",
    file: "chunk",
    desc: "PermissionV1 默认 ask→allow",
    variants: [
      ['action: "ask",\n    permission,\n    pattern: "*"\n  }', 'action: "allow",\n    permission,\n    pattern: "*"\n  }'],
      ['action: "ask",\n    permission: permission3,\n    pattern: "*"\n  }', 'action: "allow",\n    permission: permission3,\n    pattern: "*"\n  }'],
    ],
  },
  {
    id: "P3",
    file: "chunk",
    desc: "工具永不隐藏 (disabled→empty)",
    variants: [
      [
        'function disabled(tools2, ruleset) {\n  const edits = ["edit", "write", "apply_patch"];\n  return new Set(tools2.filter((tool22) => {\n    const permission = edits.includes(tool22) ? "edit" : tool22;\n    const rule = ruleset.findLast((rule2) => exports_wildcard.match(permission, rule2.permission));\n    return rule?.pattern === "*" && rule.action === "deny";\n  }));\n}',
        'function disabled(tools2, ruleset) {\n  return new Set();\n}',
      ],
      [
        'function disabled(tools2, ruleset) {\n  const edits = ["edit", "write", "apply_patch"];\n  const reads = ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"];\n  return new Set(tools2.filter((tool112) => {\n    const permission3 = edits.includes(tool112) ? "edit" : reads.includes(tool112) ? "read" : tool112;\n    const rule = ruleset.findLast((rule2) => exports_wildcard.match(permission3, rule2.permission));\n    return rule?.pattern === "*" && rule.action === "deny";\n  }));\n}',
        'function disabled(tools2, ruleset) {\n  return new Set();\n}',
      ],
    ],
  },
]

const V2_PATCHES = [
  {
    id: "P5",
    file: "chunk",
    desc: "PermissionV2 默认 ask→allow",
    variants: [
      [
        'function evaluate2(action, resource2, ...rulesets) {\n  return rulesets.flat().findLast((rule) => exports_wildcard.match(action, rule.action) && exports_wildcard.match(resource2, rule.resource)) ?? {\n    action,\n    resource: "*",\n    effect: "ask"\n  };\n}',
        'function evaluate2(action, resource2, ...rulesets) {\n  return rulesets.flat().findLast((rule) => exports_wildcard.match(action, rule.action) && exports_wildcard.match(resource2, rule.resource)) ?? {\n    action,\n    resource: "*",\n    effect: "allow"\n  };\n}',
      ],
    ],
  },
  {
    id: "P6",
    file: "chunk",
    desc: "PermissionV2 deny 判定恒 false",
    variants: [
      [
        'function denied(input, rules) {\n      return input.resources.some((resource2) => evaluate2(input.action, resource2, rules).effect === "deny");\n    }',
        'function denied(input, rules) {\n      return false;\n    }',
      ],
    ],
  },
  {
    id: "P7a-question",
    file: "chunk",
    desc: "question deny→allow",
    variants: [['{ action: "question", resource: "*", effect: "deny" }', '{ action: "question", resource: "*", effect: "allow" }']],
  },
  {
    id: "P7a-plan_enter",
    file: "chunk",
    desc: "plan_enter deny→allow",
    variants: [['{ action: "plan_enter", resource: "*", effect: "deny" }', '{ action: "plan_enter", resource: "*", effect: "allow" }']],
  },
  {
    id: "P7a-plan_exit",
    file: "chunk",
    desc: "plan_exit deny→allow",
    variants: [['{ action: "plan_exit", resource: "*", effect: "deny" }', '{ action: "plan_exit", resource: "*", effect: "allow" }']],
  },
  {
    id: "P7b-external_directory",
    file: "chunk",
    desc: "external_directory ask→allow",
    variants: [['{ action: "external_directory", resource: "*", effect: "ask" }', '{ action: "external_directory", resource: "*", effect: "allow" }']],
  },
  {
    id: "P7c-env",
    file: "chunk",
    desc: "read *.env ask→allow",
    variants: [['{ action: "read", resource: "*.env", effect: "ask" }', '{ action: "read", resource: "*.env", effect: "allow" }']],
  },
  {
    id: "P7c-env-dot",
    file: "chunk",
    desc: "read *.env.* ask→allow",
    variants: [['{ action: "read", resource: "*.env.*", effect: "ask" }', '{ action: "read", resource: "*.env.*", effect: "allow" }']],
  },
]

// P4：provider9() 内所有「内置默认 system prompt」返回清空（版本无关的组操作）
const P4_DESC = "内置默认 system prompt 清空"
const P4_RETURN_RE = /return \[([A-Za-z_$][\w$]*)(?:\.replaceAll\("[^"]*", [\w$]+\))?\]/g

// ── 基础工具 ─────────────────────────────────────────────────────────────
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex")
const sha256File = (p) => sha256(fs.readFileSync(p))
const countOf = (text, sub) => text.split(sub).length - 1

function log(msg) {
  console.log(msg)
}
function ok(msg) {
  console.log(`  [ok] ${msg}`)
}
function warn(msg) {
  console.warn(`  [warn] ${msg}`)
}
function fail(msg) {
  console.error(`\n[失败] ${msg}`)
  process.exit(1)
}

function usage(stream = console.log) {
  stream(`SHIYI 破甲包 · OpenCode Desktop (macOS) 安装器 v${INSTALLER_VERSION}

用法:
  node install-macos.mjs [选项]

选项:
  --pack <目录>         破甲包目录（含 opencode.jsonc / plugins/ / AGENTS.md / shield-protocol.md）
                        默认：本脚本所在目录
  --app <路径>          OpenCode.app 路径。默认自动探测 /Applications/OpenCode.app、~/Applications/OpenCode.app
  --asar <路径>         app.asar 路径。默认由 --app 推导：<app>/Contents/Resources/app.asar
  --config-dir <目录>   OpenCode 配置目录。默认：$XDG_CONFIG_HOME/opencode，否则 ~/.config/opencode
  --uninstall           回滚：恢复 asar 备份与 .bak-install 配置备份
  --dry-run             只分析、不写任何文件（含 patch-opencoe.js --verify-only 的校验视图）
  --verify-only         --dry-run 的别名
  --backup <路径>       自定义 asar 备份路径（默认 <asar>.orig-backup.bak）
  --no-v2               只打 P1-P4，跳过 PermissionV2 攻破（P5-P7）
  --no-sign             跳过 ad-hoc 重签名（codesign --force --deep --sign - <app>）
  --relaunch            完成后重新启动 OpenCode.app（默认不启动）
  --with-plugin-deps    额外执行 npm install @opencode-ai/plugin@<客户端版本>（默认跳过，离线友好）
  --open-links          打开 QQ 群 / 官网链接（默认只打印）
  -h, --help            显示本帮助

说明:
  - 备份：asar → <asar>.orig-backup.bak；配置 → <文件>.bak-install。已存在的备份不会被覆盖。
  - 补丁特征不匹配会失败关闭（不生成部分补丁），原 asar 不会被替换。
  - macOS 修改 asar 后必须重新签名，脚本会在 .app 内自动执行 ad-hoc 重签（可用 --no-sign 关闭）。`)
}

// ── asar 解析 / 重建 / 校验（内置实现，替代 @electron/asar） ───────────────
function parseAsar(buf) {
  if (buf.length < 16 || buf.readUInt32LE(0) !== 4) throw new Error("不是标准 asar 文件（pickle 头异常）")
  const headerSize = buf.readUInt32LE(4)
  const jsonLen = buf.readUInt32LE(12)
  const jsonEnd = 16 + jsonLen
  if (jsonEnd > buf.length || headerSize > buf.length) throw new Error("asar header 越界")
  let header
  try {
    header = JSON.parse(buf.subarray(16, jsonEnd).toString("utf8"))
  } catch (e) {
    throw new Error(`asar header JSON 解析失败: ${e.message}`)
  }
  const dataStart = 8 + headerSize
  if (dataStart > buf.length) throw new Error("asar 数据区起点越界")
  return { header, headerSize, jsonLen, dataStart }
}

// 收集所有条目：rel -> { node, kind: "file"|"unpacked"|"link", bytes? }
function collectFiles(header, dataStart, buf) {
  const files = new Map()
  ;(function walk(node, rel) {
    if (node.files) {
      for (const name of Object.keys(node.files)) walk(node.files[name], rel ? `${rel}/${name}` : name)
      return
    }
    if (node.link !== undefined) {
      files.set(rel, { node, kind: "link" })
      return
    }
    if (node.unpacked) {
      files.set(rel, { node, kind: "unpacked" })
      return
    }
    const off = Number(node.offset ?? 0)
    const size = Number(node.size ?? 0)
    if (dataStart + off + size > buf.length) throw new Error(`asar 条目越界: ${rel}`)
    files.set(rel, { node, kind: "file", bytes: buf.subarray(dataStart + off, dataStart + off + size) })
  })(header, "")
  return files
}

function computeIntegrity(data, blockSize) {
  const blocks = []
  for (let off = 0; off < data.length; off += blockSize) {
    blocks.push(sha256(data.subarray(off, Math.min(off + blockSize, data.length))))
  }
  if (!blocks.length) blocks.push(sha256(Buffer.alloc(0)))
  return { algorithm: "SHA256", hash: sha256(data), blockSize, blocks }
}

function buildHeaderBuffer(header) {
  const json = Buffer.from(JSON.stringify(header), "utf8")
  const padded = json.length + ((4 - (json.length % 4)) % 4)
  const hb = Buffer.alloc(8 + padded)
  hb.writeUInt32LE(4 + padded, 0)
  hb.writeUInt32LE(json.length, 4)
  json.copy(hb, 8)
  const sb = Buffer.alloc(8)
  sb.writeUInt32LE(4, 0)
  sb.writeUInt32LE(hb.length, 4)
  return Buffer.concat([sb, hb])
}

/**
 * 重建 asar：按 header 遍历顺序重排所有文件数据；被替换文件重算 size / integrity / offset。
 * @returns {{ out: Buffer, expected: Map<string, Buffer|null>, replaced: string[] }}
 */
function rebuildAsar(header, files, patchedMap) {
  const chunks = []
  const expected = new Map()
  const replaced = []
  let cursor = 0
  ;(function walk(node, rel) {
    if (node.files) {
      for (const name of Object.keys(node.files)) walk(node.files[name], rel ? `${rel}/${name}` : name)
      return
    }
    if (node.link !== undefined || node.unpacked) {
      expected.set(rel, null)
      return
    }
    const entry = files.get(rel)
    if (!entry || entry.kind !== "file") throw new Error(`重建时条目缺失: ${rel}`)
    let data = entry.bytes
    if (patchedMap.has(rel)) {
      data = patchedMap.get(rel)
      node.size = data.length
      if (node.integrity) node.integrity = computeIntegrity(data, node.integrity.blockSize || ASAR_INTEGRITY_BLOCK_SIZE)
      replaced.push(rel)
    }
    node.offset = String(cursor)
    chunks.push(data)
    expected.set(rel, data)
    cursor += data.length
  })(header, "")
  const out = Buffer.concat([buildHeaderBuffer(header), ...chunks])
  return { out, expected, replaced }
}

/** 逐文件校验输出：字节一致 + integrity.hash 一致 */
function verifyArchive(outBuf, expected) {
  const { header, dataStart } = parseAsar(outBuf)
  let okCount = 0
  let badCount = 0
  const bad = []
  ;(function walk(node, rel) {
    if (node.files) {
      for (const name of Object.keys(node.files)) walk(node.files[name], rel ? `${rel}/${name}` : name)
      return
    }
    if (node.link !== undefined || node.unpacked) return
    const want = expected.get(rel)
    const off = Number(node.offset ?? 0)
    const got = outBuf.subarray(dataStart + off, dataStart + off + Number(node.size ?? 0))
    const bytesSame = want != null && got.length === want.length && got.equals(want)
    const integrityOk = !node.integrity || node.integrity.hash === sha256(got)
    if (bytesSame && integrityOk) {
      okCount += 1
    } else {
      badCount += 1
      if (bad.length < 10) bad.push(`${rel} (bytes=${bytesSame} integrity=${integrityOk})`)
    }
  })(header, "")
  return { okCount, badCount, bad }
}

// ── 补丁应用 ─────────────────────────────────────────────────────────────
function applyPatches(text, patches) {
  const results = []
  for (const patch of patches) {
    let status = "miss"
    for (const [from, to] of patch.variants) {
      const c = countOf(text, from)
      if (c > 1) throw new Error(`补丁特征不唯一 (${c}): ${patch.id} ${patch.desc}`)
      if (c === 1) {
        text = text.split(from).join(to)
        status = "applied"
        break
      }
    }
    if (status === "applied") {
      // 应用后，其余变体的原文不应再存在（形态冲突视为异常）
      for (const [from] of patch.variants) {
        if (countOf(text, from) > 0) throw new Error(`补丁变体冲突: ${patch.id}`)
      }
    } else {
      const already = patch.variants.some(([, to]) => countOf(text, to) > 0)
      if (already) status = "already"
    }
    results.push({ id: patch.id, desc: patch.desc, status })
  }
  return { text, results }
}

function applyProviderPatch(text) {
  const start = text.indexOf("function provider9(")
  if (start < 0) throw new Error("未找到 provider9()，版本布局不匹配")
  const end = text.indexOf("var Service", start)
  if (end < 0 || end <= start) throw new Error("未找到 provider9() 结束边界")
  let slice = text.slice(start, end)
  const matches = [...slice.matchAll(P4_RETURN_RE)].map((m) => m[0])
  if (matches.length === 0) return { text, status: "already", count: 0 }
  for (const m of matches) {
    if (countOf(text, m) !== 1) throw new Error(`provider 默认提示特征不唯一: ${m}`)
  }
  for (const m of matches) slice = slice.split(m).join("return []")
  return { text: text.slice(0, start) + slice + text.slice(end), status: "applied", count: matches.length }
}

function runChecks(texts, { noV2 }) {
  const checks = []
  const add = (id, desc, pass) => checks.push({ id, desc, pass: Boolean(pass) })
  const { index, chunk } = texts

  add("P1", "index.js 更新器禁用", index.includes('const raw = "dev"') && !index.includes('const raw = "prod"'))

  const e3 = chunk.indexOf("function evaluate3(")
  add(
    "P2",
    "PermissionV1 默认放行",
    e3 >= 0 && /action: "allow"/.test(chunk.slice(e3, e3 + 500)) && !/action: "ask"/.test(chunk.slice(e3, e3 + 500)),
  )

  add("P3", "工具永不隐藏", /function disabled\(tools2, ruleset\)\s*\{\s*return new Set\(\);\s*\}/.test(chunk))

  {
    const s = chunk.indexOf("function provider9(")
    const e = s >= 0 ? chunk.indexOf("var Service", s) : -1
    const slice = s >= 0 && e > s ? chunk.slice(s, e) : ""
    const left = [...slice.matchAll(P4_RETURN_RE)].length
    const empties = (slice.match(/return \[\];/g) ?? []).length
    add("P4", `内置提示清空 (空返回 x${empties})`, slice.length > 0 && left === 0 && empties >= 1)
  }

  if (!noV2) {
    const e2 = chunk.indexOf("function evaluate2(")
    add(
      "P5",
      "PermissionV2 默认放行",
      e2 >= 0 && chunk.slice(e2, e2 + 400).includes('effect: "allow"') && !chunk.slice(e2, e2 + 400).includes('effect: "ask"'),
    )
    add("P6", "PermissionV2 deny 失效", /function denied\(input, rules\) \{\s*return false;\s*\}/.test(chunk))
    add(
      "P7",
      "默认 agent 门禁清空",
      !chunk.includes('{ action: "question", resource: "*", effect: "deny" }') &&
        !chunk.includes('{ action: "external_directory", resource: "*", effect: "ask" }') &&
        !chunk.includes('{ action: "read", resource: "*.env", effect: "ask" }') &&
        !chunk.includes('{ action: "read", resource: "*.env.*", effect: "ask" }'),
    )
  }
  return checks
}

function findTargets(files) {
  const indexRel = "out/main/index.js"
  if (!files.has(indexRel)) throw new Error(`asar 内未找到 ${indexRel}`)
  const candidates = []
  for (const [rel, entry] of files) {
    const m = /^out\/main\/chunks\/(node-[^/]+\.js)$/.exec(rel)
    if (!m || entry.kind !== "file") continue
    const text = entry.bytes.toString("utf8")
    let score = 0
    for (const marker of CHUNK_MARKERS) if (text.includes(marker)) score += 1
    if (score > 0) candidates.push({ rel, score })
  }
  if (!candidates.length) throw new Error("未找到包含权限/系统提示逻辑的 node-*.js core chunk")
  candidates.sort((a, b) => b.score - a.score)
  if (candidates.length > 1 && candidates[0].score === candidates[1].score) {
    throw new Error(`无法唯一定位 core chunk: ${candidates.filter((c) => c.score === candidates[0].score).map((c) => c.rel).join(", ")}`)
  }
  return { indexRel, chunkRel: candidates[0].rel, chunkScore: candidates[0].score }
}

function decodeUtf8Safe(bytes, label) {
  const text = bytes.toString("utf8")
  if (!Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`${label} 不是 UTF-8 安全文本，拒绝打补丁（避免编码损坏）`)
  }
  return text
}

// ── 配置合并（merge-config.mjs 移植） ─────────────────────────────────────
function stripJsonc(source) {
  let output = ""
  let quote = false
  let escape = false
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (lineComment) {
      if (char === "\n") {
        lineComment = false
        output += char
      }
      continue
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false
        i += 1
      }
      continue
    }
    if (quote) {
      output += char
      if (escape) escape = false
      else if (char === "\\") escape = true
      else if (char === '"') quote = false
      continue
    }
    if (char === '"') {
      quote = true
      output += char
    } else if (char === "/" && next === "/") {
      lineComment = true
      i += 1
    } else if (char === "/" && next === "*") {
      blockComment = true
      i += 1
    } else {
      output += char
    }
  }

  let result = ""
  quote = false
  escape = false
  for (let i = 0; i < output.length; i += 1) {
    const char = output[i]
    if (quote) {
      result += char
      if (escape) escape = false
      else if (char === "\\") escape = true
      else if (char === '"') quote = false
      continue
    }
    if (char === '"') {
      quote = true
      result += char
      continue
    }
    if (char === ",") {
      const rest = output.slice(i + 1)
      const match = rest.match(/^(\s*[}\]])/)
      if (match) {
        i += match[1].length - 1
        result += match[1]
        continue
      }
    }
    result += char
  }
  return result
}

function readJsonc(file) {
  return JSON.parse(stripJsonc(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")))
}

function mergeConfig(config, template) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("opencode 配置必须是 JSON 对象")
  if (!config.$schema && template.$schema) config.$schema = template.$schema

  const permission = config.permission && typeof config.permission === "object" && !Array.isArray(config.permission) ? config.permission : {}
  permission["*"] = "allow"
  config.permission = permission

  const tools = config.tools && typeof config.tools === "object" && !Array.isArray(config.tools) ? config.tools : {}
  tools["*"] = true
  config.tools = tools

  const plugin = Array.isArray(config.plugin) ? config.plugin : []
  const pluginPath = template.plugin?.[0] ?? PLUGIN_DEFAULT
  if (!plugin.includes(pluginPath)) plugin.push(pluginPath)
  config.plugin = plugin
  return config
}

// ── 进程 / 签名 ──────────────────────────────────────────────────────────
function listOpenCodePids() {
  const pids = new Set()
  const probes = [
    ["-f", "OpenCode.app/Contents"],
    ["-x", "OpenCode"],
  ]
  for (const args of probes) {
    const r = spawnSync("pgrep", args, { encoding: "utf8" })
    if (r.status === 0 && r.stdout) {
      for (const line of r.stdout.trim().split("\n")) {
        const pid = Number(line.trim())
        if (Number.isFinite(pid) && pid > 0) pids.add(pid)
      }
    }
  }
  pids.delete(process.pid)
  return [...pids]
}

function stopOpenCode({ dryRun }) {
  const found = listOpenCodePids()
  if (!found.length) return { found: [], killed: false }
  if (dryRun) return { found, killed: false }
  log(`  发现 OpenCode 进程 ${found.join(", ")}，先停止再打补丁…`)
  for (const pid of found) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  const deadline = Date.now() + 4000
  let rest = listOpenCodePids()
  while (rest.length && Date.now() < deadline) {
    spawnSync("sleep", ["0.3"])
    rest = listOpenCodePids()
  }
  if (rest.length) {
    for (const pid of rest) {
      try {
        process.kill(pid, "SIGKILL")
      } catch {}
    }
    spawnSync("sleep", ["0.3"])
    rest = listOpenCodePids()
  }
  return { found, killed: true, remaining: rest }
}

function appRootFromAsar(asarPath) {
  const m = /^(.*\.app)\/Contents\/Resources\//.exec(path.resolve(asarPath))
  return m ? m[1] : null
}

function adhocSign(appRoot, { dryRun }) {
  const cmd = `codesign --force --deep --sign - "${appRoot}"`
  if (dryRun) return { status: "planned", cmd }
  const r = spawnSync("codesign", ["--force", "--deep", "--sign", "-", appRoot], { encoding: "utf8" })
  if (r.status === 0) return { status: "signed", cmd }
  return { status: "failed", cmd, error: `${r.stderr || ""}${r.stdout || ""}`.trim().split("\n").slice(0, 3).join(" / ") }
}

function relaunchApp(appRoot) {
  const r = spawnSync("open", [appRoot], { encoding: "utf8" })
  return r.status === 0
}

// ── 备份 / 写入 ──────────────────────────────────────────────────────────
function ensureAsarBackup(asarPath, backupPath, { dryRun }) {
  if (fs.existsSync(backupPath)) {
    let valid = false
    try {
      const head = Buffer.alloc(16)
      const fd = fs.openSync(backupPath, "r")
      fs.readSync(fd, head, 0, 16, 0)
      fs.closeSync(fd)
      valid = head.readUInt32LE(0) === 4
    } catch {}
    return { created: false, valid, sha256: sha256File(backupPath), size: fs.statSync(backupPath).size }
  }
  if (dryRun) return { created: false, planned: true }
  fs.copyFileSync(asarPath, backupPath)
  return { created: true, valid: true, sha256: sha256File(backupPath), size: fs.statSync(backupPath).size }
}

function writeFileDurable(file, buf, mode) {
  const fd = fs.openSync(file, "w", mode)
  try {
    fs.writeSync(fd, buf, 0, buf.length)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

function writeAsarVerified(targetPath, outBuf, expected) {
  const tmpPath = `${targetPath}.shiyi-tmp-${process.pid}`
  try {
    const mode = fs.statSync(targetPath).mode & 0o777
    writeFileDurable(tmpPath, outBuf, mode)
    const outRead = fs.readFileSync(tmpPath)
    const v = verifyArchive(outRead, expected)
    if (v.badCount > 0) {
      throw new Error(`重打包逐文件校验失败 (${v.badCount} 个不一致): ${v.bad.join("; ")}`)
    }
    fs.renameSync(tmpPath, targetPath)
    return { okCount: v.okCount, badCount: v.badCount }
  } catch (e) {
    try {
      fs.rmSync(tmpPath, { force: true })
    } catch {}
    throw e
  }
}

// ── 安装流程 ─────────────────────────────────────────────────────────────
// 配置层：先计划（只读，解析失败即抛错——早于任何写入），再应用。
function planConfigLayer(packDir, configDir) {
  const cfgPath = path.join(configDir, "opencode.jsonc")
  const template = readJsonc(path.join(packDir, "opencode.jsonc"))

  let existingText = null
  let existing = {}
  if (fs.existsSync(cfgPath)) {
    existingText = fs.readFileSync(cfgPath, "utf8")
    existing = readJsonc(cfgPath) // 解析失败 -> 抛错，不改任何文件
  }
  const merged = mergeConfig(existing, JSON.parse(JSON.stringify(template)))
  const newText = `${JSON.stringify(merged, null, 2)}\n`
  const configChanged = existingText !== newText

  const payload = []
  for (const rel of PAYLOAD_FILES) {
    const src = path.join(packDir, rel)
    const dst = path.join(configDir, rel)
    const srcBuf = fs.readFileSync(src)
    const dstExists = fs.existsSync(dst)
    const same = dstExists && fs.readFileSync(dst).equals(srcBuf)
    payload.push({ rel, src, dst, same, dstExists, bakExists: fs.existsSync(dst + CONFIG_BACKUP_SUFFIX), bakPath: dst + CONFIG_BACKUP_SUFFIX })
  }

  const pkgPath = path.join(configDir, "package.json")
  return { cfgPath, existingText, newText, configChanged, payload, pkgPath, pkgExists: fs.existsSync(pkgPath) }
}

function applyConfigLayer(plan, configDir, { dryRun }) {
  const report = { config: null, payload: [], packageJson: null }

  if (!plan.configChanged) {
    report.config = { status: "unchanged", path: plan.cfgPath }
  } else if (dryRun) {
    report.config = {
      status: "would-write",
      path: plan.cfgPath,
      backup: plan.existingText !== null && !fs.existsSync(plan.cfgPath + CONFIG_BACKUP_SUFFIX) ? plan.cfgPath + CONFIG_BACKUP_SUFFIX : null,
    }
  } else {
    fs.mkdirSync(configDir, { recursive: true })
    let backupCreated = false
    if (plan.existingText !== null && !fs.existsSync(plan.cfgPath + CONFIG_BACKUP_SUFFIX)) {
      fs.copyFileSync(plan.cfgPath, plan.cfgPath + CONFIG_BACKUP_SUFFIX)
      backupCreated = true
    }
    fs.writeFileSync(plan.cfgPath, plan.newText, "utf8")
    report.config = { status: "written", path: plan.cfgPath, backupCreated }
  }

  for (const item of plan.payload) {
    if (item.same) {
      report.payload.push({ rel: item.rel, status: "unchanged" })
      continue
    }
    if (dryRun) {
      report.payload.push({ rel: item.rel, status: "would-write", backup: item.dstExists && !item.bakExists ? item.bakPath : null })
      continue
    }
    fs.mkdirSync(path.dirname(item.dst), { recursive: true })
    let backupCreated = false
    if (item.dstExists && !item.bakExists) {
      fs.copyFileSync(item.dst, item.bakPath)
      backupCreated = true
    }
    fs.copyFileSync(item.src, item.dst)
    report.payload.push({ rel: item.rel, status: "written", backupCreated })
  }

  if (!plan.pkgExists) {
    if (dryRun) {
      report.packageJson = { status: "would-create", path: plan.pkgPath }
    } else {
      fs.mkdirSync(configDir, { recursive: true })
      fs.writeFileSync(plan.pkgPath, `${CONFIG_PACKAGE_JSON}\n`, "utf8")
      report.packageJson = { status: "created", path: plan.pkgPath }
    }
  } else {
    report.packageJson = { status: "exists", path: plan.pkgPath }
  }
  return report
}

function installPluginDeps(configDir, version, { dryRun }) {
  const npm = spawnSync("npm", ["--version"], { encoding: "utf8" })
  if (npm.status !== 0) {
    warn("未找到 npm，跳过 @opencode-ai/plugin 安装（可用 --with-plugin-deps 手动重试）")
    return { status: "no-npm" }
  }
  const args = ["install", "--prefix", configDir, `@opencode-ai/plugin@${version}`, "--save-exact", "--no-fund", "--no-audit"]
  if (dryRun) return { status: "planned", cmd: `npm ${args.join(" ")}` }
  const r = spawnSync("npm", args, { encoding: "utf8" })
  if (r.status !== 0) {
    warn(`@opencode-ai/plugin@${version} 安装失败（不致命，补丁不受影响）: ${(r.stderr || "").trim().split("\n").slice(-2).join(" / ")}`)
    return { status: "failed" }
  }
  return { status: "installed" }
}

function runInstall(opts, paths) {
  log(`SHIYI 破甲包 · OpenCode Desktop (macOS) 安装器 v${INSTALLER_VERSION}${opts.dryRun ? "  [dry-run]" : ""}`)
  log("")

  // [1] 环境检查
  log("[1/6] 环境检查…")
  const nodeMajor = Number(process.versions.node.split(".")[0])
  if (nodeMajor < 18) fail(`需要 Node.js ≥18，当前 ${process.versions.node}`)
  const missing = REQUIRED_PACK_FILES.filter((f) => !fs.existsSync(path.join(paths.packDir, f)))
  if (missing.length) fail(`pack 目录缺少文件: ${missing.join(", ")}（用 --pack 指定破甲包目录）`)
  if (!fs.existsSync(paths.asarPath)) fail(`找不到 app.asar: ${paths.asarPath}`)
  ok(`Node.js ${process.versions.node}`)
  ok(`pack ${paths.packDir}`)
  ok(`asar ${paths.asarPath}`)
  ok(`config ${paths.configDir}`)
  if (paths.appPath) ok(`app  ${paths.appPath}`)

  // [2] 读取 asar + 分析补丁
  log("[2/6] 读取 asar、定位目标文件并模拟打补丁…")
  const buf = fs.readFileSync(paths.asarPath)
  const { header, dataStart } = parseAsar(buf)
  const files = collectFiles(header, dataStart, buf)
  const pkgEntry = files.get("package.json")
  if (!pkgEntry || pkgEntry.kind !== "file") fail("asar 内缺少 package.json")
  let version = ""
  try {
    version = JSON.parse(pkgEntry.bytes.toString("utf8")).version
  } catch {}
  if (!version) fail("无法从 asar package.json 读取版本")
  ok(`OpenCode Desktop ${version}`)

  const targets = findTargets(files)
  ok(`目标 chunk: ${targets.chunkRel} (score=${targets.chunkScore})`)

  const indexEntry = files.get(targets.indexRel)
  const chunkEntry = files.get(targets.chunkRel)
  const indexText = decodeUtf8Safe(indexEntry.bytes, targets.indexRel)
  const chunkText = decodeUtf8Safe(chunkEntry.bytes, targets.chunkRel)

  const patches = [...BASE_PATCHES, ...(opts.noV2 ? [] : V2_PATCHES)]
  const indexRes = applyPatches(indexText, patches.filter((p) => p.file === "index"))
  const chunkRes = applyPatches(chunkText, patches.filter((p) => p.file === "chunk"))
  const providerRes = applyProviderPatch(chunkRes.text)
  const results = [...indexRes.results, ...chunkRes.results, { id: "P4", desc: P4_DESC, status: providerRes.status, count: providerRes.count }]

  for (const r of results) {
    const extra = r.id === "P4" && r.status === "applied" ? ` x${r.count}` : ""
    log(`  [补丁] ${r.id} ${r.desc}: ${r.status}${extra}`)
  }

  const patchedTexts = { index: indexRes.text, chunk: providerRes.text }
  const checks = runChecks(patchedTexts, { noV2: opts.noV2 })
  const missCount = results.filter((r) => r.status === "miss").length
  const appliedCount = results.filter((r) => r.status === "applied").length
  const allChecksPass = checks.every((c) => c.pass)
  for (const c of checks) log(`  [校验] ${c.id} ${c.desc}: ${c.pass ? "通过" : "未通过"}`)
  if (missCount > 0) fail(`有 ${missCount} 条补丁特征缺失（版本布局不匹配），拒绝生成部分补丁；原 asar 未改动`)
  if (!allChecksPass) fail("补丁校验未全部通过，拒绝写回；原 asar 未改动")

  const patchedMap = new Map()
  const replacedInfo = []
  for (const [rel, text, original] of [
    [targets.indexRel, patchedTexts.index, indexText],
    [targets.chunkRel, patchedTexts.chunk, chunkText],
  ]) {
    if (text !== original) {
      const newBuf = Buffer.from(text, "utf8")
      patchedMap.set(rel, newBuf)
      replacedInfo.push({ rel, oldSize: Buffer.byteLength(original, "utf8"), newSize: newBuf.length, oldSha: sha256(Buffer.from(original, "utf8")), newSha: sha256(newBuf) })
    }
  }

  const alreadyCount = results.filter((r) => r.status === "already").length
  const asarWork = appliedCount > 0

  log(`  替换文件 ${patchedMap.size} 个: ${[...patchedMap.keys()].join(", ")}`)
  for (const info of replacedInfo) {
    log(`    · ${info.rel}: ${info.oldSize}B → ${info.newSize}B`)
    log(`      sha256 旧: ${info.oldSha}`)
    log(`      sha256 新: ${info.newSha}`)
  }

  // [3/6] 配置层计划（解析失败立即终止，早于任何写入 —— 与 ps1 一致：配置不可解析时不改应用文件）
  log("[3/6] 校验配置层…")
  let configPlan
  try {
    configPlan = planConfigLayer(paths.packDir, paths.configDir)
  } catch (e) {
    fail(`现有 opencode.jsonc 解析失败，未改动任何文件: ${e.message}`)
  }
  const configWork = configPlan.configChanged || configPlan.payload.some((p) => !p.same) || !configPlan.pkgExists
  ok(configWork ? "配置层有更新待写入" : "配置层已是最新")
  if (!asarWork) ok(`该 asar 已打满补丁（${alreadyCount} 条已应用），跳过 asar 重建`)

  if (opts.dryRun) {
    log("")
    log("[dry-run] 以下动作被跳过（不写任何文件）：")
    if (asarWork) {
      const pids = listOpenCodePids()
      log(`  [dry-run] 停止 OpenCode 进程: ${pids.length ? pids.join(", ") : "无"}`)
      log(`  [dry-run] 备份 asar → ${paths.backupPath}${fs.existsSync(paths.backupPath) ? "（已存在，将复用）" : ""}`)
      log(`  [dry-run] 写回 asar: ${paths.asarPath}`)
      const appRootDry = paths.appPath && fs.existsSync(paths.appPath) ? paths.appPath : appRootFromAsar(paths.asarPath)
      if (appRootDry && !opts.noSign) log(`  [dry-run] 重签名: codesign --force --deep --sign - "${appRootDry}"`)
    }
    if (configWork) {
      const cfgDry = applyConfigLayer(configPlan, paths.configDir, { dryRun: true })
      if (cfgDry.config.status === "would-write") log(`  [dry-run] 合并写入 ${cfgDry.config.path}${cfgDry.config.backup ? `（先备份 → ${cfgDry.config.backup}）` : ""}`)
      for (const p of cfgDry.payload) {
        if (p.status === "would-write") log(`  [dry-run] 部署 ${p.rel}${p.backup ? `（先备份 → ${p.backup}）` : ""}`)
      }
      if (cfgDry.packageJson.status === "would-create") log(`  [dry-run] 创建 ${cfgDry.packageJson.path}`)
    }
    return { version, dryRun: true, results, checks }
  }

  if (!asarWork && !configWork) {
    log("")
    ok("全部就绪：asar 已打满补丁，配置层无变化。无需操作。")
    return { version, alreadyPatched: true, results, checks }
  }

  let backup = null
  let verify = null
  let signResult = { status: "skipped" }

  // [4/6] 停止进程 + 备份 + 重建 asar + 逐文件校验
  if (asarWork) {
    log("[4/6] 停止 OpenCode / 备份 / 重建 asar…")
    const stop = stopOpenCode({ dryRun: false })
    ok(stop.found.length ? `已停止 PID: ${stop.found.join(", ")}` : "无运行中的 OpenCode 进程")

    backup = ensureAsarBackup(paths.asarPath, paths.backupPath, { dryRun: false })
    if (backup.created) {
      ok(`已备份 → ${paths.backupPath} (${backup.size}B, sha256=${backup.sha256})`)
    } else {
      ok(`备份已存在，不重复备份: ${paths.backupPath} (sha256=${backup.sha256}${backup.valid ? "" : "，警告: 文件头不是有效 asar"})`)
    }

    const { out, expected } = rebuildAsar(header, files, patchedMap)
    verify = writeAsarVerified(paths.asarPath, out, expected)
    ok(`写回完成: ${paths.asarPath} (${out.length}B)`)
    ok(`逐文件校验通过: ${verify.okCount}/${verify.okCount + verify.badCount} 个文件（字节一致 + integrity 一致）`)

    // [5/6] 重签名
    log("[5/6] 代码签名…")
    const appRoot = paths.appPath && fs.existsSync(paths.appPath) ? paths.appPath : appRootFromAsar(paths.asarPath)
    if (!appRoot) {
      ok("asar 不在 .app 包内（测试副本），跳过重签名")
    } else if (opts.noSign) {
      warn(`已按 --no-sign 跳过；手动执行: codesign --force --deep --sign - "${appRoot}"`)
    } else {
      signResult = adhocSign(appRoot, { dryRun: false })
      if (signResult.status === "signed") ok(`ad-hoc 重签名完成: ${appRoot}`)
      else warn(`重签名失败: ${signResult.error || "未知错误"}\n  手动执行: ${signResult.cmd}`)
    }
  } else {
    log("[4/6] 跳过 asar 重建（已打满补丁）")
    log("[5/6] 跳过代码签名")
  }

  // [6/6] 配置层
  log("[6/6] 部署配置与插件层…")
  const cfgReport = applyConfigLayer(configPlan, paths.configDir, { dryRun: false })
  if (cfgReport.config.status === "written") ok(`opencode.jsonc 已合并写入: ${cfgReport.config.path}${cfgReport.config.backupCreated ? "（原文件已备份 .bak-install）" : ""}`)
  else if (cfgReport.config.status === "unchanged") ok(`opencode.jsonc 已是最新，无变化: ${cfgReport.config.path}`)
  for (const p of cfgReport.payload) {
    if (p.status === "written") ok(`已部署 ${p.rel}${p.backupCreated ? "（原文件已备份 .bak-install）" : ""}`)
    else if (p.status === "unchanged") ok(`${p.rel} 已是最新，无变化`)
  }
  if (cfgReport.packageJson.status === "created") ok(`已创建 ${cfgReport.packageJson.path}`)
  else ok("package.json 已存在，保持不变")
  if (opts.withPluginDeps) {
    const deps = installPluginDeps(paths.configDir, version, { dryRun: false })
    if (deps.status === "installed") ok(`@opencode-ai/plugin@${version} 已安装`)
  }

  log("")
  ok(`完成。OpenCode Desktop ${version} 已打补丁（P1-P${opts.noV2 ? "4" : "7"}）`)
  const appRootFinal = paths.appPath && fs.existsSync(paths.appPath) ? paths.appPath : appRootFromAsar(paths.asarPath)
  if (appRootFinal && opts.relaunch) {
    if (relaunchApp(appRootFinal)) ok(`已启动 ${appRootFinal}`)
    else warn("启动失败，请手动打开 OpenCode.app")
  } else if (appRootFinal) {
    log(`  启动: open "${appRootFinal}"（或加 --relaunch 自动启动）`)
  }
  if (backup) log(`  备份: ${paths.backupPath}`)
  log(`  回滚: node install-macos.mjs --uninstall --asar "${paths.asarPath}" --config-dir "${paths.configDir}"`)
  return { version, alreadyPatched: false, results, checks, backup, signResult, verify }
}

// ── 卸载流程 ─────────────────────────────────────────────────────────────
function runUninstall(opts, paths) {
  log(`SHIYI 破甲包 · OpenCode Desktop (macOS) 卸载/回滚 v${INSTALLER_VERSION}${opts.dryRun ? "  [dry-run]" : ""}`)
  log("")
  const done = []

  // asar 恢复
  log("[1/3] 恢复 asar…")
  if (fs.existsSync(paths.backupPath)) {
    const alreadySame = fs.existsSync(paths.asarPath) && sha256File(paths.asarPath) === sha256File(paths.backupPath)
    if (alreadySame) {
      ok(`asar 已与备份一致，无需恢复 (sha256=${sha256File(paths.asarPath)})`)
      done.push("asar")
    } else if (opts.dryRun) {
      log(`  [dry-run] 计划: ${paths.backupPath} → ${paths.asarPath}`)
      done.push("asar(计划)")
    } else {
      stopOpenCode({ dryRun: false })
      const tmpPath = `${paths.asarPath}.shiyi-tmp-${process.pid}`
      try {
        const mode = fs.statSync(paths.asarPath).mode & 0o777
        fs.copyFileSync(paths.backupPath, tmpPath)
        fs.chmodSync(tmpPath, mode)
        fs.renameSync(tmpPath, paths.asarPath)
      } catch (e) {
        try {
          fs.rmSync(tmpPath, { force: true })
        } catch {}
        throw e
      }
      const restoredSha = sha256File(paths.asarPath)
      const backupSha = sha256File(paths.backupPath)
      if (restoredSha !== backupSha) fail(`恢复校验失败: ${restoredSha} != ${backupSha}`)
      ok(`已恢复 ${paths.asarPath} (sha256=${restoredSha})`)
      done.push("asar")
      const appRoot = paths.appPath && fs.existsSync(paths.appPath) ? paths.appPath : appRootFromAsar(paths.asarPath)
      if (appRoot && !opts.noSign) {
        const sign = adhocSign(appRoot, { dryRun: false })
        if (sign.status === "signed") ok(`ad-hoc 重签名完成: ${appRoot}`)
        else warn(`重签名失败，手动执行: ${sign.cmd}`)
      }
    }
  } else {
    warn(`未找到备份 ${paths.backupPath}，asar 未恢复（可能未安装过，或备份已被移动）`)
  }

  // 配置层文件回滚
  log("[2/3] 回滚配置层文件…")
  for (const rel of PAYLOAD_FILES) {
    const dst = path.join(paths.configDir, rel)
    const bak = dst + CONFIG_BACKUP_SUFFIX
    if (!fs.existsSync(dst) && !fs.existsSync(bak)) continue
    if (fs.existsSync(bak)) {
      if (opts.dryRun) {
        log(`  [dry-run] 计划恢复 ${rel} ← ${path.basename(bak)}`)
      } else {
        fs.copyFileSync(bak, dst)
        ok(`已恢复 ${rel}（来自 .bak-install 备份）`)
      }
      done.push(rel)
      continue
    }
    if (fs.existsSync(dst)) {
      let matchesPack = false
      if (paths.packProvided) {
        const src = path.join(paths.packDir, rel)
        if (fs.existsSync(src)) matchesPack = fs.readFileSync(src).equals(fs.readFileSync(dst))
      }
      if (matchesPack) {
        if (opts.dryRun) {
          log(`  [dry-run] 计划删除 ${rel}（无备份，且与破甲包内容一致）`)
        } else {
          fs.rmSync(dst)
          ok(`已删除 ${rel}（安装时新增，无备份）`)
        }
        done.push(rel)
      } else {
        warn(`${rel} 无备份且内容与破甲包不一致，保留不动（避免误删用户修改）`)
      }
    }
  }

  // 清理空的 plugins 目录（仅在彻底清空时）
  const pluginsDir = path.join(paths.configDir, "plugins")
  try {
    if (fs.existsSync(pluginsDir) && fs.readdirSync(pluginsDir).length === 0) fs.rmdirSync(pluginsDir)
  } catch {}

  // opencode.jsonc 回滚
  log("[3/3] 回滚 opencode.jsonc…")
  const cfgPath = path.join(paths.configDir, "opencode.jsonc")
  const cfgBak = cfgPath + CONFIG_BACKUP_SUFFIX
  if (fs.existsSync(cfgBak)) {
    if (opts.dryRun) {
      log(`  [dry-run] 计划恢复 opencode.jsonc ← opencode.jsonc.bak-install`)
    } else {
      fs.copyFileSync(cfgBak, cfgPath)
      ok("已恢复 opencode.jsonc（来自 .bak-install 备份）")
    }
    done.push("opencode.jsonc")
  } else if (fs.existsSync(cfgPath)) {
    try {
      const cfg = readJsonc(cfgPath)
      let changed = false
      if (cfg.permission && cfg.permission["*"] === "allow") {
        delete cfg.permission["*"]
        changed = true
        if (Object.keys(cfg.permission).length === 0) delete cfg.permission
      }
      if (cfg.tools && cfg.tools["*"] === true) {
        delete cfg.tools["*"]
        changed = true
        if (Object.keys(cfg.tools).length === 0) delete cfg.tools
      }
      if (Array.isArray(cfg.plugin)) {
        const next = cfg.plugin.filter((p) => p !== PLUGIN_DEFAULT)
        if (next.length !== cfg.plugin.length) {
          changed = true
          if (next.length === 0) delete cfg.plugin
          else cfg.plugin = next
        }
      }
      if (changed) {
        if (opts.dryRun) {
          log("  [dry-run] 计划移除合并时加入的 permission['*'] / tools['*'] / plugin 条目")
        } else {
          fs.writeFileSync(cfgPath, `${JSON.stringify(cfg, null, 2)}\n`, "utf8")
          ok("已移除合并时加入的字段（permission['*'] / tools['*'] / plugin 条目）")
        }
        done.push("opencode.jsonc")
      } else {
        ok("opencode.jsonc 未发现合并字段，保持不变")
      }
    } catch (e) {
      warn(`opencode.jsonc 解析失败，未改动: ${e.message}`)
    }
  }

  // package.json 兜底清理
  const pkgPath = path.join(paths.configDir, "package.json")
  if (fs.existsSync(pkgPath)) {
    try {
      const text = fs.readFileSync(pkgPath, "utf8")
      if (text === `${CONFIG_PACKAGE_JSON}\n` || text === CONFIG_PACKAGE_JSON) {
        if (opts.dryRun) log(`  [dry-run] 计划删除安装时创建的 ${pkgPath}`)
        else {
          fs.rmSync(pkgPath)
          ok("已删除安装时创建的 package.json")
        }
      }
    } catch {}
  }

  log("")
  if (done.length === 0) {
    warn("没有可回滚的内容（未安装过，或备份已被删除）")
  } else {
    ok(`回滚完成: ${done.join(", ")}`)
  }
  return { done }
}

// ── CLI ─────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const opts = {
    pack: null,
    app: null,
    asar: null,
    configDir: null,
    uninstall: false,
    dryRun: false,
    help: false,
    backup: null,
    noV2: false,
    noSign: false,
    relaunch: false,
    withPluginDeps: false,
    openLinks: false,
  }
  const need = (flag, i) => {
    if (i + 1 >= argv.length) {
      console.error(`参数缺少值: ${flag}`)
      process.exit(2)
    }
    return argv[i + 1]
  }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    switch (a) {
      case "--pack":
        opts.pack = need(a, i)
        i += 1
        break
      case "--app":
        opts.app = need(a, i)
        i += 1
        break
      case "--asar":
        opts.asar = need(a, i)
        i += 1
        break
      case "--config-dir":
        opts.configDir = need(a, i)
        i += 1
        break
      case "--backup":
        opts.backup = need(a, i)
        i += 1
        break
      case "--uninstall":
        opts.uninstall = true
        break
      case "--dry-run":
      case "--verify-only":
        opts.dryRun = true
        break
      case "--no-v2":
        opts.noV2 = true
        break
      case "--no-sign":
        opts.noSign = true
        break
      case "--relaunch":
        opts.relaunch = true
        break
      case "--with-plugin-deps":
        opts.withPluginDeps = true
        break
      case "--open-links":
        opts.openLinks = true
        break
      case "-h":
      case "--help":
        opts.help = true
        break
      default:
        console.error(`未知参数: ${a}`)
        console.error("用 --help 查看用法。")
        process.exit(2)
    }
  }
  return opts
}

function resolvePaths(opts) {
  const packProvided = Boolean(opts.pack)
  const packDir = path.resolve(opts.pack || SCRIPT_DIR)

  let appPath = opts.app ? path.resolve(opts.app) : null
  let asarPath = opts.asar ? path.resolve(opts.asar) : null

  if (!asarPath) {
    if (!appPath) {
      for (const candidate of DEFAULT_APP_CANDIDATES) {
        if (fs.existsSync(candidate)) {
          appPath = candidate
          break
        }
      }
      if (!appPath) fail(`未找到 OpenCode.app，请用 --app 指定。已探测: ${DEFAULT_APP_CANDIDATES.join(", ")}`)
    }
    asarPath = path.join(appPath, "Contents", "Resources", "app.asar")
  }
  if (!appPath) appPath = appRootFromAsar(asarPath)

  const configDir = path.resolve(
    opts.configDir || (process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "opencode") : path.join(os.homedir(), ".config", "opencode")),
  )
  const backupPath = path.resolve(opts.backup || asarPath + BACKUP_SUFFIX)

  return { packDir, packProvided, appPath, asarPath, configDir, backupPath }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    usage()
    process.exit(0)
  }

  for (const [name, url] of PROMO_LINKS) log(`[推广] ${name}: ${url}`)
  if (opts.openLinks && !opts.dryRun) {
    for (const [, url] of PROMO_LINKS) {
      try {
        spawnSync("open", [url])
      } catch {}
    }
  }

  const paths = resolvePaths(opts)

  try {
    if (opts.uninstall) {
      if (!fs.existsSync(paths.asarPath) && !fs.existsSync(paths.backupPath) && !fs.existsSync(paths.configDir)) {
        fail("目标 asar / 备份 / 配置目录都不存在，无可回滚内容")
      }
      runUninstall(opts, paths)
    } else {
      runInstall(opts, paths)
    }
  } catch (e) {
    fail(e && e.message ? e.message : String(e))
  }
}

main()
