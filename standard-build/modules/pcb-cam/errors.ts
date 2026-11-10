// modules/pcb-cam/errors.ts
// 新码已同步进 core/http/errors.ts 的 CODE_STATUS + CODE_HINT(护栏:core/http/tests/errors.test.ts)。
// worker 调用失败不在这里:那是后台推进(automation.ts)记进 stage_runs 的事,不经 HTTP 抛出。
export type PcbCamErrorCode =
  | 'PCB_JOB_NOT_FOUND' // 404 项目/任务不存在或不在当前租户/数据范围内(同码,不泄露存在性)
  | 'PCB_INVALID_STATE' // 409 当前状态不允许这个操作(如 running 中确认层、done 后重跑)
  | 'PCB_EQ_PENDING' // 409 还有未决策的问题点,不能放行
  | 'PCB_LAYERS_UNCONFIRMED' // 409 层识别未确认,后续 stage 不能跑
  | 'PCB_UPLOAD_INVALID' // 422 上传文件不合规(类型/大小/缺主资料包)
  | 'PCB_PROFILE_INVALID' // 422 工厂标准 YAML 不合 schema
  | 'PCB_WORKER_BUSY' // 504 引擎没在时限内响应(层预览这类同步调用;后台推进不经这里)
  | 'PCB_LAYER_NOT_READY' // 404 这一层/这个副本还没生成(如拼板没跑就看工作板层)
  | 'PCB_NO_ARTIFACTS' // 404 这个任务还没有可打包的成果物

export class PcbCamError extends Error {
  constructor(
    public code: PcbCamErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PcbCamError'
  }
}

/** 项目/任务 404 的唯一出口:不存在 / 不在租户 / 不在数据范围 —— 同一句话。 */
export function jobNotFound(): PcbCamError {
  return new PcbCamError('PCB_JOB_NOT_FOUND', '没找到这个 CAM 任务 —— 可能已被删除,或者你没有查看权限。')
}
