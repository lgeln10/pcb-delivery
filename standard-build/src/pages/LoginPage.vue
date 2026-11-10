<script setup lang="ts">
import { reactive, ref } from 'vue'
import { ElMessage } from 'element-plus'
import { LogIn, Sparkles, Bot, Boxes, Workflow } from '@lucide/vue'
import FormField from '../../core/ui-kit/FormField.vue'
import { apiLogin, errorMessage, fieldErrors } from '../api/client'
import { useAuth } from '../auth'

const auth = useAuth()
const loading = ref(false)
const errors = ref<Record<string, string>>({})
const form = reactive({
  phone: '',
  password: '',
  tenantId: '',
})

const highlights = [
  { icon: Boxes, title: '全业务在线', desc: '组织、客户、财务、单据，每一块业务都在系统里运转' },
  { icon: Workflow, title: '数据全联通', desc: '一套底座打通所有模块，不再各管各的' },
  { icon: Bot, title: 'AI 同事在场', desc: '每个人都有专属数字员工，一句话驱动业务' },
]

async function submit() {
  errors.value = {}
  if (!form.phone) errors.value.phone = '请输入手机号'
  if (!form.password) errors.value.password = '请输入密码'
  if (Object.keys(errors.value).length > 0) return

  loading.value = true
  try {
    const res = await apiLogin({
      phone: form.phone,
      password: form.password,
      tenantId: form.tenantId || undefined,
    })
    auth.setSession(res.token, res.employee)
    ElMessage.success('登录成功')
  } catch (error) {
    errors.value = fieldErrors(error)
    ElMessage.error(errorMessage(error))
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <main class="login-page">
    <section class="login-panel">
      <div class="login-copy">
        <div class="login-copy__top">
          <p class="login-copy__brand">
            <img src="/logo.png" alt="" style="width:18px;height:18px;border-radius:5px" />
            Enterprise AI OS
          </p>
          <h1>企业 <span class="login-copy__grad">AI 操作系统</span></h1>
          <p class="login-copy__lede">你的业务、数据和 AI 同事，都在同一套底座上等你。</p>
        </div>
        <ul class="login-copy__list">
          <li v-for="h in highlights" :key="h.title">
            <span class="login-copy__ico"><component :is="h.icon" :size="16" /></span>
            <span>
              <strong>{{ h.title }}</strong>
              <em>{{ h.desc }}</em>
            </span>
          </li>
        </ul>
        <!-- 「AI 心跳」轨道环:纯装饰,全页唯一常驻动画(呼吸光点) -->
        <svg class="login-orbit" viewBox="0 0 200 200" fill="none" aria-hidden="true">
          <circle cx="100" cy="100" r="88" stroke="rgba(255,255,255,0.07)" />
          <circle cx="100" cy="100" r="62" stroke="rgba(255,255,255,0.07)" />
          <path class="login-orbit__arc" d="M 100 12 A 88 88 0 0 1 176.2 56" stroke="url(#loginWarmArc)" stroke-width="2" stroke-linecap="round" />
          <circle class="login-orbit__halo" cx="100" cy="100" r="9" fill="rgba(255,178,125,0.18)" />
          <circle class="login-orbit__dot" cx="100" cy="100" r="3.5" fill="#ffc796" />
          <defs>
            <linearGradient id="loginWarmArc" x1="100" y1="12" x2="176" y2="56" gradientUnits="userSpaceOnUse">
              <stop stop-color="#ffb27d" />
              <stop offset="1" stop-color="#ffb27d" stop-opacity="0" />
            </linearGradient>
          </defs>
        </svg>
      </div>
      <form class="login-form" @submit.prevent="submit">
        <div class="login-form__head">
          <p class="login-form__kicker">Welcome back</p>
          <h2>欢迎回来</h2>
          <p>用企业账号登录，继续你的工作</p>
        </div>
        <FormField label="手机号" required :error="errors.phone">
          <el-input v-model="form.phone" autocomplete="username" placeholder="请输入手机号" />
        </FormField>
        <FormField label="密码" required :error="errors.password">
          <el-input v-model="form.password" type="password" autocomplete="current-password" placeholder="请输入密码" show-password />
        </FormField>
        <el-button native-type="submit" type="primary" :loading="loading" :icon="LogIn">进入工作台</el-button>
      </form>
    </section>
  </main>
</template>
