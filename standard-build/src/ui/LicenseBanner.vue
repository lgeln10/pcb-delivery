<script setup lang="ts">
// src/ui/LicenseBanner.vue —— 授权提示条 + 激活入口。
// - 未激活(需授权但没配)→ 红条 + 「上传授权文件」按钮(上传厂商发的 .lic 文件即激活)
// - 宽限期/超席位 → 黄条提示;过期 → 红条只读
// 仅启用强制时显示;SaaS/dev 不显示。
import { computed, ref } from 'vue'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import { ElMessage } from 'element-plus'
import { API_CLIENT_VERSION, apiGetLicense, apiActivateLicense, errorMessage } from '../api/client'

const qc = useQueryClient()
const q = useQuery({ queryKey: ['license', API_CLIENT_VERSION], queryFn: apiGetLicense, retry: false, refetchInterval: 3_600_000 })
const s = computed(() => q.data.value)
const needActivate = computed(() => !!s.value?.enforced && !s.value.configured)
const show = computed(() => !!s.value?.enforced && (needActivate.value || s.value.state === 'grace' || s.value.state === 'expired' || s.value.overSeat))
const tone = computed(() => (needActivate.value || s.value?.state === 'expired' ? 'error' : 'warn'))
const msg = computed(() => {
  const v = s.value
  if (!v) return ''
  if (needActivate.value) return '尚未激活授权，请上传授权文件后使用。'
  if (v.state === 'expired') return '授权已过期，系统当前为只读状态，请联系续费。'
  if (v.state === 'grace') return `授权已到期，处于宽限期（约 ${Math.max(0, (v.daysLeft ?? 0) + 7)} 天），请尽快续费。`
  if (v.overSeat) return `在职账号（${v.seatsUsed}）已超授权席位（${v.seats}），无法新增账号。`
  return ''
})

const fileInput = ref<HTMLInputElement | null>(null)
const busy = ref(false)
async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!f) return
  busy.value = true
  try {
    const text = await f.text()
    let license = text.trim()
    let server: string | undefined
    // 支持 .lic(JSON {license,server})或直接是 license 字符串
    if (license.startsWith('{')) {
      const j = JSON.parse(license)
      license = (j.license || '').trim()
      server = j.server
    }
    if (!license) throw new Error('文件里没有找到授权内容')
    await apiActivateLicense(license, server)
    ElMessage.success('授权已激活')
    qc.invalidateQueries({ queryKey: ['license'] })
  } catch (err) {
    ElMessage.error('激活失败：' + errorMessage(err))
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div v-if="show" class="lic-banner" :class="`lic-banner--${tone}`">
    <span>{{ msg }}</span>
    <template v-if="needActivate || s?.state === 'expired'">
      <button type="button" class="lic-banner__btn" :disabled="busy" @click="fileInput?.click()">
        {{ busy ? '激活中…' : '上传授权文件' }}
      </button>
      <input ref="fileInput" type="file" accept=".lic,.json,.key,.txt" hidden @change="onFile" />
    </template>
  </div>
</template>

<style scoped>
.lic-banner { display:flex; align-items:center; justify-content:center; gap:12px; padding:8px 16px; text-align:center; font-size:13px; font-weight:600; line-height:1.4; }
.lic-banner--warn { background:#fdf1dc; color:#b9770f; }
.lic-banner--error { background:#fde8e8; color:#cf3b3b; }
.lic-banner__btn { border:none; border-radius:6px; padding:5px 14px; font-size:12px; font-weight:700; cursor:pointer; background:#fff; color:#cf3b3b; }
.lic-banner__btn:disabled { opacity:.6; cursor:default; }
</style>
