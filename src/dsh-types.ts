/** DSH 接缝最小类型镜像：只描述本插件真正用到的字段，避免绑死某个 DSH 版本。 */
export interface DshToolExecution {
  readonly signal: AbortSignal
  readonly agent?: unknown
  readonly toolCallId?: string
  [key: string]: unknown
}

export interface DshContentBlock {
  type: string
  text?: string
  [key: string]: unknown
}
