// core/ui-kit 出口:模块 ui 从这里 import 组件;token 在 app 入口 import './tokens.css'。
export { default as AsyncState } from './AsyncState.vue'
export { default as ConfirmButton } from './ConfirmButton.vue'
export { default as FormField } from './FormField.vue'
export { default as MarkdownView } from './MarkdownView.vue'
// 「模型该在哪一页配」的唯一说法,两处编辑面共用(见组件头注:光加提示挡不住)
export { default as ModelRoutingNotice } from './ModelRoutingNotice.vue'
