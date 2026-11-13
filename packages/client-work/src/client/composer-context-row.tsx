/**
 * Context row directly above the composer card.
 *
 * Everything that qualifies the draft lives outside the card: the Feishu
 * conversation the session is following and the work-mode toggle share one row
 * above the input, so the card itself stays the plain DSH composer. DSH renders
 * `conversation.input.dock` entries between the last transcript block and the
 * composer, which is exactly the band the design uses.
 */

import * as React from 'react'

import type { WorkbenchController } from './controller.js'
import { FeishuContextChip, type QuoteInserter } from './feishu-context.js'
import { WorkModeChip, type WorkNotify } from './work-session-ui.js'

export interface ComposerContextRowProps {
  sessionId: string
  workbench: WorkbenchController
  notify: WorkNotify
  inputActions?: QuoteInserter | undefined
}

/**
 * The row matches the composer card's width and left edge: the card is centered
 * inside the composer clearance gutter, so the row repeats that geometry instead
 * of stretching across the whole conversation column.
 */
const ROW_STYLE: React.CSSProperties = {
  boxSizing: 'border-box',
  display: 'flex',
  alignItems: 'center',
  flexWrap: 'wrap',
  gap: 10,
  width: 'calc(100% - var(--dsh-composer-side-clearance, 16px) - var(--dsh-composer-side-clearance, 16px))',
  maxWidth: 'var(--dsh-composer-card-max-width, 100%)',
  margin: '0 auto',
}

export function ComposerContextRow({
  sessionId,
  workbench,
  notify,
  inputActions,
}: ComposerContextRowProps): React.ReactElement {
  return (
    <div style={ROW_STYLE} data-dsh-work-composer-context="">
      <FeishuContextChip
        sessionId={sessionId}
        workbench={workbench}
        notify={notify}
        inputActions={inputActions}
      />
      <WorkModeChip sessionId={sessionId} workbench={workbench} notify={notify} />
    </div>
  )
}
