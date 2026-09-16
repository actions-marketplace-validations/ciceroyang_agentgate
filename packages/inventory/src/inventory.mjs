/** Pure inventory parsing and evidence matching; no filesystem, network or execution. */
const MAX_BYTES = 1024 * 1024
const MAX_ENTRIES = 500
const INPUT_FIELDS = ['name', 'server', 'package', 'registry', 'version']
const SEVERITIES = ['critical', 'high', 'medium', 'low', 'info']
const LABELS = {
  matched: '版本与证据对应', unmatched: '当前索引未找到', ambiguous: '需要确认候选',
  version_missing: '需要你的精确版本', version_mismatch: '版本不一致', insufficient: '证据不足',
}
const LIMIT = '结论只覆盖列出的已检查材料，不代表整包、传递依赖或运行时安全。'
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0
const textOrNull = (value) => typeof value === 'string' ? value : null
const own = (value, key) => object(value) && Object.hasOwn(value, key)
const npmName = (value) => typeof value === 'string' && /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/.test(value)

function exactVersion(value, registry) {
  if (!nonempty(value) || !/\d/.test(value) || /[\s*^~<>=|,\[\](){}\/]/.test(value) || /(?:^|[.\-_])x(?:$|[.\-_])/i.test(value)) return false
  if (registry === 'npm') return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value)
  return /^\d[0-9A-Za-z.!+_-]*$/.test(value)
}

function fromName(value) {
  const name = value.trim()
  const at = name.lastIndexOf('@')
  // An ordinary registry server such as org.example/server@1.0.0 is not an npm package.
  if (at > 0 && npmName(name.slice(0, at)) && nonempty(name.slice(at + 1))) {
    return { name, server: null, package: name.slice(0, at), registry: 'npm', version: name.slice(at + 1) }
  }
  return { name, server: null, package: null, registry: null, version: null }
}

function normalizeInput(value, position) {
  if (typeof value === 'string' && nonempty(value)) return fromName(value)
  if (!object(value) || Object.keys(value).some((key) => !INPUT_FIELDS.includes(key))) {
    throw new Error('第 ' + position + ' 项格式不支持：只接受名称或 name/server/package/registry/version 字段，不接受启动配置、环境变量或凭据。')
  }
  const result = {}
  for (const field of INPUT_FIELDS) {
    const item = value[field]
    if (item !== undefined && item !== null && typeof item !== 'string') throw new Error('第 ' + position + ' 项的 ' + field + ' 必须是文本或 null。')
    result[field] = typeof item === 'string' && item.trim() ? item.trim() : null
  }
  result.name = result.name || result.server || result.package
  if (!result.name) throw new Error('第 ' + position + ' 项缺少名称，请提供 name、server 或 package。')
  return result
}

export function parseInventory(text) {
  if (typeof text !== 'string') throw new Error('请提供文本清单或 JSON 文本。')
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('清单不能超过 1 MB。')
  const trimmed = text.trim()
  if (!trimmed) return []
  let values
  if (/^[\[{]/.test(trimmed)) {
    let parsed
    try { parsed = JSON.parse(trimmed) } catch { throw new Error('JSON 格式错误，请使用数组或 {"tools":[...]}。') }
    if (Array.isArray(parsed)) values = parsed
    else if (object(parsed) && Object.keys(parsed).length === 1 && own(parsed, 'tools') && Array.isArray(parsed.tools)) values = parsed.tools
    else throw new Error('JSON 只接受数组或 {"tools":[...]}；不能导入 mcpServers、env 或其它配置结构。')
  } else {
    if (/^\s*["']?(?:mcpServers|env)["']?\s*:/im.test(trimmed)) throw new Error('不能导入 mcpServers 或 env 配置，请只粘贴工具名称和版本。')
    values = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  }
  if (values.length > MAX_ENTRIES) throw new Error('一次最多支持 500 项工具。')
  return values.map((value, index) => ({ id: 'tool-' + (index + 1), ...normalizeInput(value, index + 1) }))
}

function inputProjection(entry) {
  return Object.fromEntries(INPUT_FIELDS.map((field) => [field, textOrNull(entry?.[field])]))
}

function findingProjection(finding, block) {
  const result = { block }
  for (const field of ['rule', 'severity', 'file', 'message', 'evidence']) result[field] = textOrNull(finding?.[field])
  return result
}

function provenanceProjection(value) {
  if (!object(value)) return null
  return {
    package: { registry: textOrNull(value.package?.registry), name: textOrNull(value.package?.name), version: textOrNull(value.package?.version) },
    content: { algorithm: textOrNull(value.content?.algorithm), digest: textOrNull(value.content?.digest), scope: textOrNull(value.content?.scope) },
    complete: value.complete === true,
  }
}

function evidenceOf(record) {
  if (!object(record?.evidence)) return []
  return Object.keys(record.evidence).map((block) => {
    const value = record.evidence[block]
    return {
      block, status: textOrNull(value?.status), source: textOrNull(value?.source), reason: textOrNull(value?.reason),
      provenance: provenanceProjection(value?.provenance),
      findings: Array.isArray(value?.findings) ? value.findings.map((finding) => findingProjection(finding, block)) : [],
    }
  })
}

function bindingProblem(record, candidate) {
  if (!object(record) || !nonempty(record.server) || !Array.isArray(record.packages) ||
      record.packages.some((pkg) => !object(pkg) || !nonempty(pkg.registry) || !nonempty(pkg.name) || !exactVersion(pkg.version, pkg.registry))) return '索引记录缺少可核对的精确包身份，或包记录格式不完整。'
  if (!nonempty(candidate.package) || !nonempty(candidate.registry) || !exactVersion(candidate.version, candidate.registry)) return '该记录没有可核对的精确包身份和版本。'
  if (candidate.registry === 'npm' && !npmName(candidate.package)) return '索引中的 npm 包名格式不完整，不能核对包身份。'
  if (record.verdict === 'incomplete' || (record.verdict !== undefined && !['clean', 'findings', 'incomplete'].includes(record.verdict))) return '索引将这条记录标为未完成或未知状态。'
  if (!object(record.evidence) || Object.keys(record.evidence).length === 0) return '索引没有提供检查证据。'
  for (const [block, evidence] of Object.entries(record.evidence)) {
    if (!object(evidence) || !['clean', 'findings'].includes(evidence.status) || !nonempty(evidence.source) || !Array.isArray(evidence.findings)) return block + ' 未完成检查，或证据格式不完整。'
    if (nonempty(evidence.reason) || nonempty(evidence.error)) return block + ' 仍带有检查未完成或失败的说明，需要先核对。'
    if ((evidence.status === 'clean' && evidence.findings.length > 0) || (evidence.status === 'findings' && evidence.findings.length === 0)) return block + ' 的检查状态与发现列表相互矛盾。'
    if (evidence.findings.some((finding) => !object(finding) || !nonempty(finding.rule) || !SEVERITIES.includes(finding.severity) || (!nonempty(finding.evidence) && !nonempty(finding.message)))) return block + ' 包含未知或缺少说明的发现，不能作为完整证据。'
    const proof = evidence.provenance
    if (!object(proof) || proof.complete !== true || !object(proof.package) || !object(proof.content)) return block + ' 缺少完整的内容来源证明。'
    if (proof.package.registry !== candidate.registry || proof.package.name !== candidate.package || proof.package.version !== candidate.version) return block + ' 的来源证明与所选包、来源或版本不一致。'
    if (proof.content.algorithm !== 'sha256' || typeof proof.content.digest !== 'string' || !/^[a-f0-9]{64}$/i.test(proof.content.digest) || !nonempty(proof.content.scope)) return block + ' 缺少有效 SHA256 内容摘要或明确的检查范围。'
  }
  return null
}

function candidateGroups(records) {
  const groups = new Map()
  for (const record of records) {
    if (!object(record) || !nonempty(record.server)) continue
    const packages = Array.isArray(record.packages) && record.packages.length > 0 ? record.packages : [null]
    for (const pkg of packages) {
      const candidate = { server: record.server, package: textOrNull(pkg?.name), registry: textOrNull(pkg?.registry), version: textOrNull(pkg?.version) }
      const key = 'candidate:' + JSON.stringify([candidate.server, candidate.registry, candidate.package, candidate.version])
      const existing = groups.get(key)
      if (existing) existing.records.push(record)
      else groups.set(key, { key, ...candidate, records: [record] })
    }
  }
  return [...groups.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
}

function candidatesFor(entry, groups) {
  const pool = groups.filter((candidate) => !entry.registry || candidate.registry === entry.registry)
  let exact
  if (entry.server || entry.package) {
    exact = pool.filter((candidate) => (!entry.server || candidate.server === entry.server) && (!entry.package || candidate.package === entry.package))
  } else {
    exact = pool.filter((candidate) => candidate.server === entry.name)
    if (exact.length === 0) exact = pool.filter((candidate) => candidate.package === entry.name)
  }
  if (exact.length > 0) return { candidates: exact, exact: true }
  const includes = (haystack, needle) => typeof haystack === 'string' && haystack.toLowerCase().includes(needle.toLowerCase())
  const fuzzy = pool.filter((candidate) => {
    if (entry.server || entry.package) return (!entry.server || includes(candidate.server, entry.server)) && (!entry.package || includes(candidate.package, entry.package))
    return includes(candidate.server, entry.name) || includes(candidate.package, entry.name) || candidate.records.some((record) => includes(record.title, entry.name))
  })
  return { candidates: fuzzy, exact: false }
}

const candidateProjection = (candidate) => ({ key: candidate.key, server: candidate.server, package: candidate.package, registry: candidate.registry, version: candidate.version })
const selectedProjection = (candidate) => ({ server: candidate.server, package: candidate.package, registry: candidate.registry, version: candidate.version })

function setState(item, state, reason, steps = []) {
  return { ...item, state, label: LABELS[state], reason, nextSteps: [...steps, LIMIT] }
}

export function createInventoryReport(entries, index, options = {}) {
  if (!Array.isArray(entries)) throw new Error('工具清单必须是数组，请先解析清单。')
  if (entries.length > MAX_ENTRIES) throw new Error('一次最多支持 500 项工具。')
  const validIndex = object(index) && Array.isArray(index.records)
  const records = validIndex ? index.records : []
  const groups = candidateGroups(records)
  const snapshot = index?.snapshot === true || index?.sample === true
  const truncated = index?.truncated === true
  const selections = object(options?.selections) ? options.selections : {}
  const counts = new Map()
  const ids = new Map()
  for (const entry of entries) {
    const input = inputProjection(entry)
    const key = JSON.stringify([input.server, input.package, input.registry, input.version, input.server || input.package ? null : input.name])
    counts.set(key, (counts.get(key) || 0) + 1)
    ids.set(entry?.id, (ids.get(entry?.id) || 0) + 1)
  }
  const items = entries.map((entry, position) => {
    const input = inputProjection(entry)
    const id = typeof entry?.id === 'string' ? entry.id : 'tool-' + (position + 1)
    let item = { id, input, state: 'insufficient', label: LABELS.insufficient, reason: '', nextSteps: [], candidates: [], selected: null, evidenceGeneratedAt: null, evidence: [], findings: [] }
    const wellFormed = object(entry) && /^tool-[1-9]\d*$/.test(id) && nonempty(entry.name) &&
      Object.keys(entry).every((key) => INPUT_FIELDS.includes(key) || key === 'id') &&
      INPUT_FIELDS.every((key) => entry[key] === null || entry[key] === undefined || typeof entry[key] === 'string')
    if (!wellFormed) return setState(item, 'insufficient', '这项工具记录格式不完整，不能据此匹配。', ['只保留名称、包名、来源和你实际使用的版本，再重新导入。'])
    const duplicateKey = JSON.stringify([input.server, input.package, input.registry, input.version, input.server || input.package ? null : input.name])
    if (counts.get(duplicateKey) > 1 || ids.get(entry.id) > 1) return setState(item, 'insufficient', '清单中存在重复工具或重复标识，需要先核对并去重。', ['保留一条真实工具记录，或补充不同的包、来源和版本。'])
    if (!validIndex) return setState(item, 'insufficient', '当前索引格式错误或没有可读取的记录列表。', ['提供有效的证据索引后重新生成报告。'])
    const matches = candidatesFor(input, groups)
    item.candidates = matches.candidates.map(candidateProjection)
    if (matches.candidates.length === 0) return setState(item, 'unmatched', '当前索引中没有找到对应工具；这不表示工具安全或不存在。' + (truncated ? '本次索引已截断，未覆盖全部记录。' : ''), ['核对准确的 registry server、包名及来源，必要时使用完整索引。'])
    const selection = own(selections, id) ? selections[id] : null
    let candidate = selection ? matches.candidates.find((candidate) => candidate.key === selection) : null
    if (selection && !candidate) return setState(item, 'ambiguous', '之前选择的候选已不在当前结果中，请重新确认。', ['从当前候选中选择你实际使用的工具。'])
    if (!candidate) {
      const sameVersion = matches.candidates.filter((candidate) => exactVersion(input.version, candidate.registry) && input.version === candidate.version)
      const choices = sameVersion.length > 0 ? sameVersion : matches.candidates
      if (!matches.exact || choices.length !== 1) return setState(item, 'ambiguous', matches.exact ? '存在多个包、来源或版本候选，不能自动确定你的工具。' : '这些只是名称相近的候选，即使只有一项也需要你确认。', ['选择实际使用的候选，并填写你自己的精确版本。'])
      candidate = choices[0]
    }
    item.selected = selectedProjection(candidate)
    item.evidenceGeneratedAt = textOrNull(candidate.records[0].generatedAt ?? index.generatedAt)
    item.evidence = evidenceOf(candidate.records[0])
    item.findings = item.evidence.flatMap((evidence) => evidence.findings)
    if (candidate.records.length !== 1) return setState(item, 'insufficient', '索引中有相同包身份的重复记录，无法确认哪一份证据有效。', ['先核对重复索引记录，再生成报告。'])
    if (!nonempty(candidate.package) || !nonempty(candidate.registry) || !exactVersion(candidate.version, candidate.registry)) return setState(item, 'insufficient', '索引记录缺少精确包身份或版本，不能核对你所用的版本。', ['获取带有准确包名、来源和精确版本的索引记录。'])
    if (!exactVersion(input.version, candidate.registry)) return setState(item, 'version_missing', '需要你实际使用的精确版本；空值、latest 或版本范围都不能用于证据匹配。', ['填写本机或配置中确认的实际版本；不要直接复制候选版本。'])
    if (input.version !== candidate.version) return setState(item, 'version_mismatch', '你提供的版本 ' + input.version + ' 与索引候选版本 ' + (candidate.version || '未记录') + ' 不同，现有证据不能移用。', ['获取你所用版本的对应证据，或核对版本填写是否准确。'])
    if (snapshot) return setState(item, 'insufficient', '当前索引是历史样本快照，不能作为你的工具已完成检查的证明。', ['换用带有当前检查来源证明的真实索引。'])
    if (['snapshot', 'sample'].some((key) => own(index, key) && typeof index[key] !== 'boolean')) return setState(item, 'insufficient', '索引的快照或样本标记格式不明确，无法确认其证据用途。', ['核对索引来源、快照和样本标记。'])
    if (!nonempty(item.evidenceGeneratedAt) || !Number.isFinite(Date.parse(item.evidenceGeneratedAt))) return setState(item, 'insufficient', '索引和记录没有提供可解析的证据生成时间，无法说明这些材料何时被检查。', ['补充真实的证据生成时间后重新核对；不要自行猜测时间。'])
    const problem = bindingProblem(candidate.records[0], candidate)
    if (problem) return setState(item, 'insufficient', problem, ['补齐对应版本的完整检查状态、内容摘要和检查范围。'])
    item = setState(item, 'matched', '工具身份、你的精确版本与列出的检查证据对应；这不是安全认证。', item.findings.length ? ['逐条查看下面的发现，并决定是否需要人工处理。'] : ['如工具版本或材料发生变化，请重新核对证据。'])
    if (item.findings.length > 0) item.label = '版本与证据对应，有发现待查看'
    return item
  })
  return {
    schemaVersion: 1,
    generatedAt: nonempty(options?.generatedAt) ? options.generatedAt : new Date().toISOString(),
    index: {
      generatedAt: textOrNull(index?.generatedAt), snapshot, scanner: textOrNull(index?.scanner), truncated,
      total: Number.isInteger(index?.total) && index.total >= records.length ? index.total : records.length,
    },
    summary: { total: items.length, matched: items.filter((item) => item.state === 'matched').length, needsAttention: items.filter((item) => item.state !== 'matched' || item.findings.length > 0).length },
    items,
  }
}
