/** Settings section for the Feishu connection. */

import * as React from 'react'

import type {} from '@deepseek-ai/dsh-client-ui-settings/client'

import type { FeishuStatusView, WorkbenchController } from './controller.js'
import {
  PRESENCE_SAMPLE,
  PRESENCE_STYLE_OPTIONS,
  presenceChipTokens,
  presenceStyle,
  type PresenceStyle,
} from './presence-style.js'

export interface FeishuSettingsInject {
  workbench: WorkbenchController
}

export interface FeishuSettingsOwner {
  close: () => void
}

export function FeishuSettingsSection({
  workbench,
  close,
}: FeishuSettingsInject & FeishuSettingsOwner): React.ReactElement {
  const [status, setStatus] = React.useState<FeishuStatusView>({ connected: false })
  const [authUrl, setAuthUrl] = React.useState<string | undefined>()
  const [appInfo, setAppInfo] = React.useState<{ configured: boolean; appId?: string }>({ configured: false })
  const [appId, setAppId] = React.useState('')
  const [appSecret, setAppSecret] = React.useState('')
  const [appBusy, setAppBusy] = React.useState(false)
  const [appNotice, setAppNotice] = React.useState<string | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const refresh = React.useCallback(async () => {
    try {
      setStatus(await workbench.feishuStatus())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [workbench])

  const refreshApp = React.useCallback(async () => {
    try {
      setAppInfo(await workbench.feishuAppInfo())
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [workbench])

  React.useEffect(() => {
    void refresh()
    void refreshApp()
  }, [refresh, refreshApp])

  async function saveApp(): Promise<void> {
    setAppBusy(true)
    setError(null)
    setAppNotice(null)
    try {
      await workbench.configureFeishuApp(appId, appSecret)
      setAppId('')
      setAppSecret('')
      setAppNotice('应用凭据已保存')
      await refreshApp()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setAppBusy(false)
    }
  }

  async function connect(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const started = await workbench.feishuStart()
      setAuthUrl(started.url)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function disconnect(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      await workbench.feishuDisconnect()
      setAuthUrl(undefined)
      await refresh()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 20, maxWidth: 680 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>飞书</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.7, lineHeight: 1.6 }}>
          连接后 DSH Work 可以读写你权限内的飞书文档、表格与云空间，并把任务成果分享到群。
        </p>
      </div>

      <div
        style={{
          border: '1px solid var(--dsh-border, rgba(127,127,127,.24))',
          borderRadius: 12,
          padding: 14,
          display: 'grid',
          gap: 8,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>应用凭据</div>
        <div style={{ fontSize: 11, opacity: 0.55 }}>
          企业自建应用的 App ID / Secret，只存本机 DSH 凭据；配置后即可连接。
        </div>
        <input
          value={appId}
          onChange={(event) => setAppId(event.target.value)}
          placeholder="App ID（cli_...）"
          style={{
            padding: '7px 9px',
            borderRadius: 7,
            border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
            background: 'transparent',
            color: 'inherit',
            fontSize: 12,
          }}
        />
        <input
          type="password"
          value={appSecret}
          onChange={(event) => setAppSecret(event.target.value)}
          placeholder="App Secret"
          style={{
            padding: '7px 9px',
            borderRadius: 7,
            border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
            background: 'transparent',
            color: 'inherit',
            fontSize: 12,
          }}
        />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button type="button" disabled={appBusy} onClick={() => void saveApp()} style={{ padding: '5px 10px', borderRadius: 7 }}>
            {appBusy ? '保存中…' : '保存应用凭据'}
          </button>
          {appInfo.configured ? (
            <span style={{ fontSize: 11, opacity: 0.6 }}>已配置：{appInfo.appId}</span>
          ) : (
            <span style={{ fontSize: 11, opacity: 0.6 }}>未配置</span>
          )}
          {appNotice ? <span style={{ fontSize: 11, color: 'var(--dsh-success, #2f9e44)' }}>{appNotice}</span> : null}
        </div>
      </div>

      <div
        style={{
          border: '1px solid var(--dsh-border, rgba(127,127,127,.24))',
          borderRadius: 12,
          padding: 14,
          display: 'grid',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            aria-hidden="true"
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: !status.connected
                ? 'rgba(127,127,127,.5)'
                : status.tokenState === 'refresh_pending'
                  ? '#f59f00'
                  : '#2f9e44',
            }}
          />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 14 }}>
              {status.connected
                ? `已连接 ${status.name ?? status.openId ?? ''}${
                    status.tokenState === 'refresh_pending' ? '（token 已过期，下次调用自动刷新）' : ''
                  }`
                : status.reason === 'refresh_expired' || status.reason === 'access_expired'
                  ? '未连接：授权已失效，请重新连接'
                  : '未连接'}
            </div>
            <div style={{ fontSize: 12, opacity: 0.55, marginTop: 2 }}>
              {status.connected && status.expiresAt
                ? `token 到期：${new Date(status.expiresAt).toLocaleString('zh-CN', { hour12: false })}${
                    status.tokenState === 'refresh_pending' && status.refreshExpiresAt
                      ? `（refresh 有效期至 ${new Date(status.refreshExpiresAt).toLocaleString('zh-CN', { hour12: false })}）`
                      : ''
                  }`
                : '授权码只保存在本机 DSH 凭据中'}
            </div>
          </div>
          {status.connected ? (
            <button type="button" disabled={busy} onClick={() => void disconnect()} style={{ padding: '6px 12px', borderRadius: 8 }}>
              断开
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={() => void connect()} style={{ padding: '6px 12px', borderRadius: 8 }}>
              连接飞书
            </button>
          )}
        </div>

        {authUrl ? (
          <div style={{ fontSize: 13, lineHeight: 1.6 }}>
            <a href={authUrl} target="_blank" rel="noreferrer">
              打开飞书授权页
            </a>
            <button
              type="button"
              onClick={() => void refresh()}
              style={{ marginLeft: 10, padding: '3px 8px', borderRadius: 6 }}
            >
              我已授权，刷新
            </button>
          </div>
        ) : null}

        {status.scope ? (
          <div style={{ fontSize: 11, opacity: 0.5, wordBreak: 'break-all' }}>scope: {status.scope}</div>
        ) : null}

        {error ? (
          <div role="alert" style={{ color: 'var(--dsh-danger, #d33)', fontSize: 12 }}>
            {error}
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" onClick={close} style={{ padding: '7px 14px', borderRadius: 8 }}>
          完成
        </button>
      </div>
    </div>
  )
}

/**
 * A static copy of the chip, so the picker shows the real shape and tokens.
 *
 * The sample text must stay fictional: this card ships with the plugin and is
 * screenshotted into its docs, so a real conversation name here would leak
 * someone's chat into every install.
 */
function StylePreview({ style }: { style: PresenceStyle }): React.ReactElement {
  const tokens = presenceChipTokens(style, true)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        height: 24,
        padding: '0 8px',
        color: 'inherit',
        maxWidth: 280,
        ...tokens.pill,
      }}
    >
      <span aria-hidden="true" style={{ flex: '0 0 auto', ...tokens.glyphStyle }}>
        {tokens.glyph}
      </span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          ...tokens.name,
        }}
      >
        {PRESENCE_SAMPLE.kindLabel}｜{PRESENCE_SAMPLE.chatName}
      </span>
      <span style={{ flex: '0 0 auto', ...tokens.detail }}>· {PRESENCE_SAMPLE.detail}</span>
    </span>
  )
}

export function WorkGeneralSettings({
  workbench,
  close,
}: FeishuSettingsInject & FeishuSettingsOwner): React.ReactElement {
  const [defaultModel, setDefaultModel] = React.useState('')
  const [notifyChatId, setNotifyChatId] = React.useState('')
  const [chipStyle, setChipStyle] = React.useState<PresenceStyle>('dsh')
  const [styleBusy, setStyleBusy] = React.useState<PresenceStyle | null>(null)
  const [busy, setBusy] = React.useState(false)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    void (async () => {
      try {
        const settings = await workbench.getSettings()
        setDefaultModel(settings.defaultModel ?? '')
        setNotifyChatId(settings.notifyChatId ?? '')
        setChipStyle(presenceStyle(settings.presenceStyle))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    })()
  }, [workbench])

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const saved = await workbench.setSettings({ defaultModel, notifyChatId })
      setDefaultModel(saved.defaultModel ?? '')
      setNotifyChatId(saved.notifyChatId ?? '')
      setNotice('已保存')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function pickStyle(id: PresenceStyle): Promise<void> {
    const previous = chipStyle
    setChipStyle(id)
    setStyleBusy(id)
    setError(null)
    setNotice(null)
    try {
      await workbench.setPresenceStyle(id)
      setNotice('已切换飞书会话 chip 风格')
    } catch (cause) {
      // The controller reverted its own state; keep the picker in step.
      setChipStyle(previous)
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStyleBusy(null)
    }
  }

  return (
    <form onSubmit={save} style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 20, maxWidth: 680 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>工作台</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.7, lineHeight: 1.6 }}>
          新任务的默认模型与定时通知目标；留空表示使用 DSH 默认值。
        </p>
      </div>

      <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        默认模型
        <input
          value={defaultModel}
          onChange={(event) => setDefaultModel(event.target.value)}
          placeholder="例如 glm-5.3-flash；留空使用默认"
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
            background: 'transparent',
            color: 'inherit',
          }}
        />
      </label>

      <label style={{ display: 'grid', gap: 6, fontSize: 13 }}>
        定时通知 chat_id
        <input
          value={notifyChatId}
          onChange={(event) => setNotifyChatId(event.target.value)}
          placeholder="oc_...；留空则定时任务不推送"
          style={{
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--dsh-border, rgba(127,127,127,.3))',
            background: 'transparent',
            color: 'inherit',
          }}
        />
      </label>

      <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'grid', gap: 8 }}>
        <legend style={{ fontSize: 13, padding: 0 }}>飞书会话 chip 风格</legend>
        <p style={{ margin: 0, fontSize: 12, opacity: 0.7, lineHeight: 1.6 }}>
          只改变输入框下方引用 chip 的外观，引用内容与行为不变；选中即生效并保存。
        </p>
        <div style={{ display: 'grid', gap: 8 }}>
          {PRESENCE_STYLE_OPTIONS.map((option) => {
            const selected = chipStyle === option.id
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                disabled={styleBusy !== null}
                onClick={() => void pickStyle(option.id)}
                style={{
                  display: 'grid',
                  gap: 6,
                  textAlign: 'left',
                  padding: 10,
                  borderRadius: 10,
                  cursor: styleBusy ? 'progress' : 'pointer',
                  color: 'inherit',
                  border: `1px solid ${
                    selected
                      ? 'var(--dsh-accent, rgba(59,130,246,.6))'
                      : 'var(--dsh-border, rgba(127,127,127,.3))'
                  }`,
                  background: selected ? 'rgba(59,130,246,.06)' : 'transparent',
                  opacity: styleBusy !== null && !selected ? 0.6 : 1,
                }}
              >
                <span style={{ fontSize: 13 }}>
                  {option.label}
                  {selected ? <span style={{ opacity: 0.6 }}> · 使用中</span> : null}
                  {styleBusy === option.id ? <span style={{ opacity: 0.6 }}> · 保存中…</span> : null}
                </span>
                <span style={{ fontSize: 12, opacity: 0.7 }}>{option.hint}</span>
                <StylePreview style={option.id} />
              </button>
            )
          })}
        </div>
      </fieldset>

      {notice ? <div style={{ fontSize: 12, color: 'var(--dsh-success, #2f9e44)' }}>{notice}</div> : null}
      {error ? (
        <div role="alert" style={{ color: 'var(--dsh-danger, #d33)', fontSize: 12 }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="submit" disabled={busy} style={{ padding: '7px 14px', borderRadius: 8 }}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" onClick={close} style={{ padding: '7px 14px', borderRadius: 8 }}>
          完成
        </button>
      </div>
    </form>
  )
}

export function DataSettings({
  workbench,
  close,
}: FeishuSettingsInject & FeishuSettingsOwner): React.ReactElement {
  const [armed, setArmed] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [exporting, setExporting] = React.useState(false)
  const [exportPath, setExportPath] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  async function exportData(): Promise<void> {
    setExporting(true)
    setError(null)
    setNotice(null)
    try {
      const result = await workbench.exportData()
      setExportPath(result.path)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setExporting(false)
    }
  }

  async function clear(): Promise<void> {
    if (!armed) {
      setArmed(true)
      return
    }
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await workbench.clearData()
      setNotice(`已清空：${result.tasks} 个任务、${result.artifacts} 个成果`)
      setArmed(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 20, maxWidth: 680 }}>
      <div>
        <h2 style={{ margin: 0, fontSize: 18 }}>工作数据</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, opacity: 0.7, lineHeight: 1.6 }}>
          只清空 Work 任务记录、成果索引与磁盘文件。不会删除 DSH 会话、飞书云端的文档/表格、token 与连接配置。
        </p>
      </div>

      <div
        style={{
          border: '1px solid var(--dsh-danger, #d33)',
          borderRadius: 12,
          padding: 14,
          display: 'grid',
          gap: 10,
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 600 }}>导出数据</div>
        <div style={{ fontSize: 12, opacity: 0.65, lineHeight: 1.6 }}>
          导出全部 Work 数据（tasks/artifacts/shares 索引 + 成果文件），保存在本机。
        </div>
        <button
          type="button"
          disabled={exporting}
          onClick={() => void exportData()}
          style={{ justifySelf: 'start', padding: '7px 12px', borderRadius: 8 }}
        >
          {exporting ? '导出中…' : '导出数据'}
        </button>
        {exportPath ? (
          <div style={{ fontSize: 11, opacity: 0.65, wordBreak: 'break-all' }}>已导出：{exportPath}</div>
        ) : null}

        <div style={{ fontSize: 13, fontWeight: 600, marginTop: 6 }}>清空本地数据</div>
        <div style={{ fontSize: 12, opacity: 0.65, lineHeight: 1.6 }}>
          不可撤销。Work 任务记录与成果文件会从本机删除，但 DSH 会话仍保留在侧栏。建议先导出/分享需要保留的成果。
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void clear()}
          style={{
            justifySelf: 'start',
            padding: '7px 12px',
            borderRadius: 8,
            border: '1px solid var(--dsh-danger, #d33)',
            background: armed ? 'var(--dsh-danger, #d33)' : 'transparent',
            color: armed ? '#fff' : 'inherit',
          }}
        >
          {busy ? '清空中…' : armed ? '再次点击确认清空 Work 数据' : '清空 Work 数据'}
        </button>
        {notice ? <div style={{ fontSize: 12, color: 'var(--dsh-success, #2f9e44)' }}>{notice}</div> : null}
        {error ? (
          <div role="alert" style={{ color: 'var(--dsh-danger, #d33)', fontSize: 12 }}>
            {error}
          </div>
        ) : null}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" onClick={close} style={{ padding: '7px 14px', borderRadius: 8 }}>
          完成
        </button>
      </div>
    </div>
  )
}

type SettingsTab = 'connection' | 'preferences' | 'data'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'connection', label: '连接' },
  { id: 'preferences', label: '偏好' },
  { id: 'data', label: '工作数据' },
]

export function FeishuSettingsShell({
  workbench,
  close,
}: FeishuSettingsInject & FeishuSettingsOwner): React.ReactElement {
  const [tab, setTab] = React.useState<SettingsTab>('connection')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', gap: 4, padding: '12px 20px 0', flexWrap: 'wrap' }}>
        {SETTINGS_TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            style={{
              padding: '4px 10px',
              borderRadius: 7,
              border: '1px solid',
              borderColor:
                tab === item.id ? 'var(--dsh-accent, rgba(59,130,246,.7))' : 'transparent',
              background: tab === item.id ? 'rgba(59,130,246,.1)' : 'transparent',
              color: 'inherit',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {tab === 'connection' ? <FeishuSettingsSection workbench={workbench} close={close} /> : null}
        {tab === 'preferences' ? <WorkGeneralSettings workbench={workbench} close={close} /> : null}
        {tab === 'data' ? <DataSettings workbench={workbench} close={close} /> : null}
      </div>
    </div>
  )
}
