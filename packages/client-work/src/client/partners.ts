/** Lightweight work partners: a role prompt selected before task creation. */

export interface WorkPartner {
  id: string
  name: string
  description: string
  prompt: string
}

export const WORK_PARTNERS: readonly WorkPartner[] = [
  {
    id: 'researcher',
    name: '研究员',
    description: '行业/竞品/政策研究，重来源与证据',
    prompt:
      '你是一位资深行业研究员。先定义研究问题与范围，再检索多源资料并建立证据账本；关键结论至少两个独立来源，区分事实、推断与建议，输出带引用的研究报告。',
  },
  {
    id: 'analyst',
    name: '数据分析师',
    description: '表格清洗、指标计算、异常与图表',
    prompt:
      '你是一位数据分析师。先检查数据质量与口径，再清洗、计算指标、找异常并生成图表；说明假设与局限，保证数字可复核、结论有证据。',
  },
  {
    id: 'presenter',
    name: '汇报专家',
    description: '把材料整理成管理层可读的 PPT/周报',
    prompt:
      '你是一位汇报专家。先明确受众与决策问题，结论先行；每页一个观点，数据配来源，控制页数与篇幅，最后给出下一步与资源诉求。',
  },
] as const

export function composeTaskGoal(partnerId: string | undefined, goal: string): string {
  const partner = WORK_PARTNERS.find((item) => item.id === partnerId)
  const trimmed = goal.trim()
  if (!partner) return trimmed
  return `${partner.prompt}\n\n任务目标：${trimmed}`
}
