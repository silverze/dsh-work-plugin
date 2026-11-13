/** Session-scoped right-sidebar work panel: current task, library, schedules. */

import * as React from 'react'

import type { ArtifactView, WorkbenchController, WorkTaskView } from './controller.js'

type PanelTab = 'task' | 'library' | 'schedules'

const STATUS_LABEL: Record<string, string> = {
  draft: '草稿',
  queued: '排队',
  running: '运行中',
  waiting_user: '等待确认',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--dsh-border, rgba(127,127,127,.22))',
  borderRadius: 10,
  padding: 12,
  display: 'grid',
  gap: 8,
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function tabButtonStyle(active: boolean): React.CSSProperties {
  return {
    padding: '4px 9px',
    borderRadius: 7,
    border: '1px solid',
    borderColor: active ? 'var(--dsh-accent, rgba(59,130,246,.7))' : 'transparent',
    background: active ? 'rgba(59,130,246,.1)' : 'transparent',
    color: 'inherit',
    fontSize: 12,
    cursor: 'pointer',
  }
}

export function WorkPanel({
  sessionId,
  workbench,
}: {
  sessionId: string
  workbench: WorkbenchController
}): React.ReactElement {
  const [tab, setTab] = React.useState<PanelTab>('task')
  const [task, setTask] = React.useState<WorkTaskView | undefined>()
  const [artifacts, setArtifacts] = React.useState<ArtifactView[]>([])
  const [library, setLibrary] = React.useState<ArtifactView[]>([])
  const [schedules, setSchedules] = React.useState<WorkTaskView[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [followUp, setFollowUp] = React.useState('')
  const [scheduleOpen, setScheduleOpen] = React.useState(false)
  const [rrule, setRrule] = React.useState('')
  const [chatId, setChatId] = React.useState('')
  const [kind, setKind] = React.useState('')
  const [query, setQuery] = React.useState('')

  const loadTask = React.useCallback(async () => {
    try {
      const next = await workbench.getTask(sessionId)
      setTask(next)
      setArtifacts(next ? await workbench.listArtifacts(sessionId) : [])
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [sessionId, workbench])

  const loadLibrary = React.useCallback(async () => {
    try {
      setLibrary(
        await workbench.listLibrary({
          ...(kind ? { kind } : {}),
          ...(query.trim() ? { query: query.trim() } : {}),
        }),
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [kind, query, workbench])

  const loadSchedules = React.useCallback(async () => {
    try {
      const tasks = await workbench.listTasks({ limit: 200 })
      setSchedules(tasks.filter((item) => Boolean(item.scheduleId)))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [workbench])

  React.useEffect(() => {
    void loadTask()
  }, [loadTask])

  React.useEffect(() => {
    if (tab === 'library') void loadLibrary()
    if (tab === 'schedules') void loadSchedules()
  }, [tab, loadLibrary, loadSchedules])

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 12, height: '100%', overflow: 'auto' }}>
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        <button type="button" style={tabButtonStyle(tab === 'task')} onClick={() => setTab('task')}>当前任务</button>
        <button type="button" style={tabButtonStyle(tab === 'library')} onClick={() => setTab('library')}>成果库</button>
        <button type="button" style={tabButtonStyle(tab === 'schedules')} onClick={() => setTab('schedules')}>定时</button>
      </div>

      {error ? <div role="alert" style={{ fontSize: 11, color: 'var(--dsh-danger, #d33)' }}>{error}</div> : null}

      {tab === 'task' ? (
        !task ? (
          <div style={{ ...cardStyle, fontSize: 12, lineHeight: 1.6, opacity: 0.8 }}>
            <div>当前会话还不是工作任务。</div>
            <div style={{ opacity: 0.65 }}>
              点击输入框左侧“工作模式”，或在 `+` 菜单选择“工作模式”，再正常发送目标。
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => { await workbench.attachSession(sessionId); await loadTask() })}
              style={{ justifySelf: 'start', padding: '5px 10px', borderRadius: 7 }}
            >
              开启工作模式
            </button>
          </div>
        ) : (
          <>
            <div style={cardStyle}>
              <div style={{ fontSize: 11, opacity: 0.6 }}>{STATUS_LABEL[task.status] ?? task.status} · {new Date(task.updatedAt).toLocaleString('zh-CN', { hour12: false })}</div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{task.title}</div>
              <div style={{ fontSize: 12, opacity: 0.75, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{task.goal}</div>
              {task.lastError ? <div style={{ fontSize: 11, color: 'var(--dsh-danger, #d33)' }}>{task.lastError.message}</div> : null}
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" disabled={busy} onClick={() => void run(async () => { await workbench.scanArtifacts(sessionId); await loadTask() })} style={{ padding: '4px 9px', borderRadius: 7 }}>刷新产物</button>
                <button type="button" disabled={busy} onClick={() => void run(async () => { await workbench.cancelTask(sessionId); await loadTask() })} style={{ padding: '4px 9px', borderRadius: 7 }}>取消</button>
                <button type="button" onClick={() => setScheduleOpen((value) => !value)} style={{ padding: '4px 9px', borderRadius: 7 }}>定时</button>
              </div>
              {scheduleOpen ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  <input value={rrule} onChange={(event) => setRrule(event.target.value)} placeholder="RRULE，例如 DTSTART;TZID=Asia/Shanghai:20261110T090000\nRRULE:FREQ=DAILY" style={{ padding: '5px 8px', borderRadius: 7, border: '1px solid var(--dsh-border, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', fontSize: 11 }} />
                  <input value={chatId} onChange={(event) => setChatId(event.target.value)} placeholder="可选：飞书群 chat_id" style={{ padding: '5px 8px', borderRadius: 7, border: '1px solid var(--dsh-border, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', fontSize: 11 }} />
                  <button type="button" disabled={busy || !rrule.trim()} onClick={() => void run(async () => { await workbench.scheduleTask(sessionId, rrule, chatId); setScheduleOpen(false) })} style={{ justifySelf: 'start', padding: '4px 9px', borderRadius: 7 }}>保存定时</button>
                </div>
              ) : null}
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={followUp} onChange={(event) => setFollowUp(event.target.value)} placeholder="追加要求" style={{ flex: 1, padding: '5px 8px', borderRadius: 7, border: '1px solid var(--dsh-border, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', fontSize: 11 }} />
                <button type="button" disabled={busy || !followUp.trim()} onClick={() => void run(async () => { await workbench.promptTask(sessionId, followUp); setFollowUp('') })} style={{ padding: '4px 9px', borderRadius: 7 }}>追加</button>
              </div>
            </div>

            <div style={{ ...cardStyle, gap: 6 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>产物 {artifacts.length} 个</div>
              {artifacts.length === 0 ? <div style={{ fontSize: 11, opacity: 0.55 }}>还没有产物。</div> : artifacts.map((artifact) => (
                <div key={artifact.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
                  <span style={{ opacity: 0.6 }}>{artifact.kind}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={artifact.path}>{artifact.path.split(/[/\\]/).pop()}</span>
                  <span style={{ opacity: 0.5 }}>{formatSize(artifact.size)}</span>
                  <button type="button" onClick={() => workbench.openArtifact(artifact.taskId, artifact.path)} style={{ padding: '2px 6px', borderRadius: 5 }}>预览</button>
                  <button type="button" disabled={busy} onClick={() => void run(async () => { await workbench.shareArtifact(artifact.id) })} style={{ padding: '2px 6px', borderRadius: 5 }}>分享</button>
                </div>
              ))}
            </div>
          </>
        )
      ) : null}

      {tab === 'library' ? (
        <div style={{ display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <select value={kind} onChange={(event) => setKind(event.target.value)} style={{ padding: '4px 7px', borderRadius: 7, background: 'transparent', color: 'inherit', border: '1px solid var(--dsh-border, rgba(127,127,127,.3))' }}>
              <option value="">全部类型</option>
              <option value="docx">文档</option>
              <option value="pptx">演示</option>
              <option value="xlsx">表格</option>
              <option value="pdf">PDF</option>
              <option value="png">图片</option>
              <option value="md">Markdown</option>
              <option value="other">其他</option>
            </select>
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索路径" style={{ flex: 1, minWidth: 120, padding: '4px 7px', borderRadius: 7, border: '1px solid var(--dsh-border, rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', fontSize: 11 }} />
            <button type="button" onClick={() => void loadLibrary()} style={{ padding: '4px 8px', borderRadius: 7 }}>搜索</button>
          </div>
          {library.length === 0 ? <div style={{ fontSize: 11, opacity: 0.55 }}>成果库为空。</div> : library.map((artifact) => (
            <div key={artifact.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
              <span style={{ opacity: 0.6 }}>{artifact.kind}</span>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={artifact.path}>{artifact.path.split(/[/\\]/).pop()}</span>
              <button type="button" onClick={() => workbench.openArtifact(artifact.taskId, artifact.path)} style={{ padding: '2px 6px', borderRadius: 5 }}>预览</button>
              <button type="button" onClick={() => workbench.openSession(artifact.taskId)} style={{ padding: '2px 6px', borderRadius: 5 }}>会话</button>
            </div>
          ))}
        </div>
      ) : null}

      {tab === 'schedules' ? (
        <div style={{ display: 'grid', gap: 6 }}>
          {schedules.length === 0 ? <div style={{ fontSize: 11, opacity: 0.55 }}>还没有定时任务。</div> : schedules.map((item) => (
            <div key={item.id} style={{ ...cardStyle, padding: 9, gap: 4 }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{item.title}</div>
              <div style={{ fontSize: 10, opacity: 0.55 }}>schedule: {item.scheduleId}</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button type="button" disabled={busy} onClick={() => void run(async () => { await workbench.runSchedule(item.scheduleId!); await loadSchedules() })} style={{ padding: '3px 7px', borderRadius: 6 }}>立即运行</button>
                <button type="button" disabled={busy} onClick={() => void run(async () => { await workbench.schedulePause(item.scheduleId!, false); await loadSchedules() })} style={{ padding: '3px 7px', borderRadius: 6 }}>暂停</button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
