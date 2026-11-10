// modules/pcb-cam/ui/parts/useSfx.ts
// 提示音:每步完成 / 判一条 / 放行盖章各一记短音(WebAudio 合成,无音频文件)。默认关,localStorage 记忆;
// 产线上戴耳机看队列的人才开 —— 声音是「不用盯屏也知道跑完了」,不是装饰。
import { ref } from 'vue'

const KEY = 'pcb-cam.sfx'
const enabled = ref<boolean>(typeof localStorage !== 'undefined' && localStorage.getItem(KEY) === 'on')
let ctx: AudioContext | null = null

type Kind = 'stage' | 'decide' | 'done' | 'stamp' | 'error'
const NOTES: Record<Kind, Array<[number, number]>> = {
  stage: [[880, 0.06]],
  decide: [[1320, 0.04]],
  done: [[660, 0.08], [990, 0.12]],
  stamp: [[220, 0.05], [110, 0.18]],
  error: [[330, 0.12], [262, 0.16]],
}

function play(kind: Kind) {
  if (!enabled.value) return
  try {
    ctx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
    let t = ctx.currentTime
    for (const [freq, dur] of NOTES[kind]) {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = kind === 'stamp' ? 'square' : 'sine'
      o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, t)
      g.gain.exponentialRampToValueAtTime(0.18, t + 0.005)
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      o.connect(g).connect(ctx.destination)
      o.start(t)
      o.stop(t + dur + 0.02)
      t += dur
    }
  } catch {
    // 无音频设备 / 未经用户手势的自动播放被拒:静默
  }
}

export function useSfx() {
  function toggle() {
    enabled.value = !enabled.value
    try {
      localStorage.setItem(KEY, enabled.value ? 'on' : 'off')
    } catch {
      // 隐私模式没有 localStorage
    }
    if (enabled.value) play('decide')
  }
  return { sfxOn: enabled, toggleSfx: toggle, sfx: play }
}
