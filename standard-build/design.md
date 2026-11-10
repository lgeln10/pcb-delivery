# 设计系统 · 企业智能体(design.md)

> 「企业智能体」板块所有页面的**统一设计依据**。落地任何一页前先读这份;它把认可的原型设计语言固化成可复用的 token + 组件 + 布局规范。
>
> 唯一 token 来源:`core/ui-kit/tokens.css`。页面**禁止裸色值/裸像素**(质量红线),一律引用 `--sb-*` 变量。本文只规定「怎么组合这些 token 成一致的界面」。

---

## 0. 一句话基调

**冷静、克制、可信。** 冷调近白的底 + 纯白卡片 + 一个蓝主色,信息紧凑、留白有节制;唯一的「彩色情绪」给两处——**数字员工头像**(身份辨识)和**琥珀色审批闸**(「管得住」的信号)。深浅色双主题同等对待。

三条原则:
1. **紧凑 > 空旷**:卡片间用 `--sb-space-3/4`,不堆大间距;满血铺满、不留外圈灰框。
2. **语义色只服务功能**:蓝=主操作/进行中,绿=在岗/完成,**琥珀=需人工确认**,红=异常/逾期。多彩仅限头像与交付物图标。
3. **状态先于数字**:该关注的用形(pill/描边/图标)一眼可辨,不靠读数字。

---

## 1. 颜色 token

全部来自 `tokens.css`,深色/暗金主题自动跟随,组件**只引用语义层**:

| 用途 | token | 说明 |
|---|---|---|
| 主色 / 主操作 / 进行中 | `--sb-color-primary` `--sb-color-primary-soft` | 蓝 #2f6bed |
| 在岗 / 完成 / 成功 | `--sb-color-success` `--sb-color-success-soft` | 绿 |
| **审批闸 / 需人工确认** | `--sb-gate` `--sb-gate-soft` `--sb-gate-border` | ★琥珀(=warning 的语义别名),表示「危险动作要人点头」 |
| 异常 / 逾期 / 失败 | `--sb-color-danger` `--sb-color-danger-soft` | 红 |
| 文本四级 | `--sb-text-primary/secondary/tertiary/placeholder` | 主/次/弱/占位 |
| 表面层次 | `--sb-bg-page`(应用底) `--sb-bg-card`(卡片) `--sb-bg-subtle`(只读底/hover) | |
| 描边 | `--sb-border` `--sb-border-strong` | |
| 头像身份色 | `--sb-avatar-1` … `--sb-avatar-6` | 按 id 稳定取色,**仅**用于头像/交付物图标 |

**取头像色的标准写法**(消除组件里的裸色数组):
```ts
const AVATARS = ['--sb-avatar-1','--sb-avatar-2','--sb-avatar-3','--sb-avatar-4','--sb-avatar-5','--sb-avatar-6']
function avatarColor(seed: string): string {
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) & 0x7fffffff
  return `var(${AVATARS[h % AVATARS.length]})`
}
// 用法: :style="{ background: avatarColor(emp.id) }"
```

---

## 2. 排版

- 字号刻度:`--sb-font-xs(12) / sm(13) / md(14) / lg(16) / xl(20) / 2xl(26)`。正文 `sm`,卡片标题 `md`,页面大标题 `2xl`(`font-weight:750`,`letter-spacing:-.01em`)。
- kicker(小标签):`xs` + `text-transform:uppercase` + `letter-spacing:var(--sb-tracking-caps)` + 主色。
- 数字对齐:凡有数字列(统计块、金额、计数)加 `.num`(`font-variant-numeric: tabular-nums`)。
- 行高:正文 `--sb-leading-normal(1.5)`,密集列表 `1.55~1.6`。

---

## 3. 间距 / 圆角 / 阴影

- 间距只用 `--sb-space-1..10`(4 基数)。页面级留白 `space-6`,卡片内 `space-4/5`,行内 `space-2/3`。
- 圆角:卡片 `--sb-radius-lg(12)`,控件/小卡 `--sb-radius-md(8)`,pill `--sb-radius-pill`。头像 10–16px(方圆角,非正圆)。
- 阴影:卡片一律 `--sb-shadow-card`(极轻);浮层 `--sb-shadow-pop`。**不叠重阴影**。

---

## 4. 组件规范(class 约定)

> 组件样式写在各自 `.vue` 的 `<style scoped>`,用下面的**结构与 token**,保证跨页一致。

### 卡片 / 面板
白底(`--sb-bg-card`)+ `1px --sb-border` + `--sb-radius-lg` + `--sb-shadow-card`,内边距 `space-4/5`。面板头:标题(`md`/700,前置 16px 图标)+ 右侧 `更多 →` 文本按钮(主色)。

### 统计块(stat tile)
一行 4 个;左侧大数字(27px/750/`.num`)+ 下方 `xs` 弱色标签,右上角 32px 圆角图标底(语义 soft 底 + 语义色)。整块可点则 hover 变 `--sb-border-strong`。

### Pill / 徽章
`xs`/700 + `--sb-radius-pill` + 语义 soft 底 + 语义色:
- `进行中` → primary;`已完成`/`在岗` → success;`待确认`/`需审批` → gate;`异常`/`逾期` → danger;`停用` → 弱色(`--sb-bg-subtle` + tertiary)。

### 按钮
主 `.btn--go`(主色实底白字);次 `.btn`(白底 + `--sb-border-strong` 描边 + 次要文本色,hover 描边加深);文本按钮(无底,主色)。破坏性操作走 `ConfirmButton`(二次确认,质量红线)。

### 头像
方圆角(radius 10–16),白字首两字,`avatarColor(id)` 取身份色;右下角 `--sb-color-success` 在线点(2px 卡片色描边);离线用 `--sb-text-tertiary`。

★**真人同事的默认形态就是「首两字 + 身份色」,没有默认图片。** 有图只可能是他自己在「个人设置」
页传的(`employees.avatar_url`)。`public/avatars/` 那 8 张 3D 数字人是**数字员工/AI 智能体**的资产,
不许按 id 挑一张套到真人身上 —— 那等于系统替每个人认领了一张脸,而且当事人改不了(2026-08-16 修)。

### 标签页(tabs)
底部 1px 边线;项 `sm`/600,选中=主色 + 2px 主色下边线(`margin-bottom:-1px` 压边线)。带计数用 gate 小徽章。

### 对话气泡 + 工具轨迹
助手气泡=白底描边卡片;用户气泡=`--sb-color-primary-soft`。拆解清单用「① ② ③」主色序号。工具调用=`--sb-bg-subtle` 小卡:`工具` 弱标 + 工具名(强)+ 结果(弱)+ 绿 `✓`。

### ★审批闸卡片(招牌)
`--sb-gate-soft` 底 + `--sb-gate-border` 边 + **左侧 3px `--sb-gate` 竖条**。内含:`为什么被拦`(gate soft 小标)+ 提交人 + 标题 + 说明 + 灰底草稿预览 + 动作区(`批准并执行` / `改后批准` / `要求重做` / `驳回`)。**这是产品差异化的视觉锚点,任何「需人工确认」都用它。**

### 空态 / 提示卡
空态:居中弱色说明 + 一个引导动作。虚线提示卡(`hint-card`):虚线边 + 图标 + 标题/说明 + 右侧文本链接。**诚实**:未接入的能力显式说明「接入中/去 XX」,不假装有数据。

### 流程节点(工作流)
竖向节点链:每节点 34px 圆角图标(语义色实底白字)+ 标题/说明,节点间 2px 竖线。**人工审批节点**用 `--sb-gate` 图标 + gate 标题色 + `需人工确认` gate 徽章,视觉上明显区别于自动节点。

### 表格(权限中心等)
表头 `xs`/uppercase/弱色;单元格 `sm`;行 1px 下边线。布尔值:`✓`(success)/ `需审批`(gate,700)/ `—`(弱色),不用裸文字。

---

## 5. 页面布局模式(企业智能体)

### A. 全宽满血(所有二级页)
内容区 `.app-main` 自带 `32px 左右 + 40px 底` 内边距 + 标题栏 `24px` 下间距。**沉浸式三栏页**(如数字员工)要满血铺满、消除外圈灰框,页面根用负边距抵消:
```css
.shell { display: grid; flex: 1; min-height: 0;
  margin: calc(-1*var(--sb-gap-section)) calc(-1*var(--sb-space-8)) calc(-1*var(--sb-space-10)); }
```
**普通仪表/列表页**保留 `.app-main` 内边距,内容**占满可用宽度**(不设 `max-width`,右侧不留白)。

### B. 名册 + 工位 + 收件箱(数字员工)
三栏:`名册(288)｜工位(1fr)｜收件箱(328)`。**收件箱仅在主导航收起时显示**(展开时空间不够自动隐藏)——用 App.vue `provide('navCollapsed')` 联动。窄屏(<1120)降级为两栏。

### C. 仪表盘(智能工作台)
纵向:大标题区 → 4 统计块 → `1.5fr / 1fr` 两栏面板(左:待我确认 + 运行中工作流;右:我的数字员工 + 最近产出)。

---

## 6. Do / Don't

**Do** — 卡片轻阴影+细边;紧凑间距;语义色克制;头像给身份;审批闸醒目;深浅色都验;数字用 `.num`;空态诚实。

**Don't** — ✗ 裸色值/裸像素(用 token) ✗ 多彩滥用(彩色只给头像/交付物图标) ✗ 大片空旷/外圈灰框 ✗ 重叠厚阴影 ✗ 危险动作直接执行(必须走审批闸) ✗ 用「真实/演示」这类实现细节措辞 ✗ 漏五态(加载/空/错误/无权限/成功)。

---

## 7. 实施约定(与工程红线一致)

- 只走 `src/api/client.ts` 取数;数据视图包 `AsyncState`(五态);破坏性操作 `ConfirmButton`。
- 颜色/间距只用 `tokens.css` 变量;新语义先加 token 再用,不在组件写裸值。
- 每个带独立入口的写操作:`permissions.ts` 注册权限点 + 后端 `requirePermission` + 前端菜单级(`nav-catalog`)与按钮级(`v-if="canXxx"`)双门控。
- 演示口径的内容(如工位任务/自动任务的按角色示例)必须**代码注释标注**,并说明真实数据源(P2/P3 接入点),便于替换。

---

*本文随「企业智能体」页面推进持续更新;token 变更以 `core/ui-kit/tokens.css` 为准,组件模式以已落地的 `SuperindividualHub.vue` / `DigitalEmployeesPage.vue` / `DigitalEmployeeDesk.vue` 为参考实现。*
