// scripts/export-docs.ts
// Rebuilds the lightweight documentation handoff package from standard-build.
// standard-build/ is the only source of truth; standard-build-docs/ is generated.
import { access, cp, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDir, '..')
const workspaceRoot = path.resolve(projectRoot, '..')
const outputRoot = path.resolve(workspaceRoot, 'standard-build-docs', 'standard-build-docs')

const moduleCopies = [
  { name: '_TEMPLATE', files: ['MODULE.md'], sourceDir: path.join(projectRoot, 'modules', '_TEMPLATE') },
  { name: 'org', files: ['MODULE.md'], sourceDir: path.join(projectRoot, 'core', 'org') },
  { name: 'partner', files: ['MODULE.md'], sourceDir: path.join(projectRoot, 'modules', 'partner') },
  { name: 'document', files: ['MODULE.md'], sourceDir: path.join(projectRoot, 'modules', 'document') },
  { name: 'finance', files: ['MODULE.md'], sourceDir: path.join(projectRoot, 'modules', 'finance') },
  { name: 'analytics', files: ['MODULE.md', 'METRICS.md'], sourceDir: path.join(projectRoot, 'modules', 'analytics') },
]

function assertSafeOutputPath() {
  const expected = path.join(workspaceRoot, 'standard-build-docs', 'standard-build-docs')
  if (outputRoot !== expected) {
    throw new Error(`Refusing to export docs outside expected output path: ${outputRoot}`)
  }
  if (path.basename(outputRoot) !== 'standard-build-docs') {
    throw new Error(`Refusing to remove unexpected output directory: ${outputRoot}`)
  }
  if (path.basename(path.dirname(outputRoot)) !== 'standard-build-docs') {
    throw new Error(`Refusing to remove unexpected parent directory: ${path.dirname(outputRoot)}`)
  }
}

async function assertExists(target: string) {
  try {
    await access(target)
  } catch {
    throw new Error(`Missing required docs source: ${target}`)
  }
}

function packageIndex() {
  return `# 标准件交付包 · 总索引

> 本目录由 \`standard-build/scripts/export-docs.ts\` 自动生成。不要手工修改本目录内文件。
> 唯一真相源在 \`standard-build/\`。

## 怎么用这个包

**让 Claude Code 开工**:把整个目录给它,让它从 \`docs/START_HERE.md\` 开始读。

**人想理解全局**:读 \`docs/ENGINEERING_BLUEPRINT.md\`(方法论)+ \`docs/DATA_MODEL.md\`(数据模型总览)。

## 文件清单

### 开工入口
- \`docs/START_HERE.md\` ★ — 给 Claude Code 的开工指令(读什么、技术栈、构建顺序、第一个动作)
- \`docs/README_FOR_AGENTS.md\` — 文档路由(agent 按角色读哪些)

### 方法论与规范
- \`docs/ENGINEERING_BLUEPRINT.md\` — 完整宪法(范式/可改性/质量基线/双agent)
- \`docs/IMPL_AGENT.md\` — 实现agent常驻(铁律+协议+红线)→ 设为 CLAUDE.md
- \`docs/REQ_AGENT.md\` — 需求agent常驻(对话原则+工单格式)
- \`docs/QUALITY_GUARDRAILS.md\` — 质量红线固化清单(测试/lint/schema)
- \`docs/DATA_ANALYTICS.md\` — 分析型数据规范(OLTP/OLAP边界、指标口径、汇总表、导出、对账)

### 数据模型(地基)
- \`docs/DATA_MODEL.md\` ★ — 总览(四模块咬合、依赖图、实体主权、构建顺序)
- \`docs/DATA_MODEL_org.md\` ★ — 组织权限(公共字段基类/身份/数据权限)
- \`docs/DATA_MODEL_partner.md\` — 伙伴+薄CRM
- \`docs/DATA_MODEL_document.md\` ★ — 单据能力插座 + 6步叠加配方
- \`docs/DATA_MODEL_finance.md\` ★ — 标准财务 + 科目表 + 凭证映射(领域知识)

### 模块文档
- \`modules/{org,partner,document,finance,analytics}/MODULE.md\` — 各模块文档
- \`modules/analytics/METRICS.md\` — 指标口径真相源样板
- \`modules/_TEMPLATE/MODULE.md\` — 新模块模板(将来叠加业务时复制)

## 重新生成

在 \`standard-build/\` 下运行:

\`\`\`bash
npm run docs:export
\`\`\`
`
}

function generatedNotice() {
  return `# GENERATED - DO NOT EDIT

This package is generated from \`standard-build/\`.

- Source docs: \`standard-build/docs/\`
- Source module docs: \`standard-build/core/org/MODULE.md\` and \`standard-build/modules/*/MODULE.md\`
- Export command: \`npm run docs:export\` from \`standard-build/\`

If this package is stale, regenerate it instead of editing files here.
`
}

async function copyModuleDocs() {
  for (const moduleCopy of moduleCopies) {
    const destinationDir = path.join(outputRoot, 'modules', moduleCopy.name)
    await mkdir(destinationDir, { recursive: true })
    for (const file of moduleCopy.files) {
      const sourceFile = path.join(moduleCopy.sourceDir, file)
      await assertExists(sourceFile)
      await cp(sourceFile, path.join(destinationDir, file))
    }
  }
}

async function main() {
  assertSafeOutputPath()
  await assertExists(path.join(projectRoot, 'docs'))

  await rm(outputRoot, { recursive: true, force: true })
  await mkdir(outputRoot, { recursive: true })
  await cp(path.join(projectRoot, 'docs'), path.join(outputRoot, 'docs'), { recursive: true })
  await copyModuleDocs()
  await writeFile(path.join(outputRoot, 'INDEX.md'), packageIndex())
  await writeFile(path.join(outputRoot, 'GENERATED.md'), generatedNotice())

  console.log(`Exported docs package to ${path.relative(workspaceRoot, outputRoot)}`)
}

await main()
