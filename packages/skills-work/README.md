# Work skills

六个 DSH 技能资产，供 `work` preset 通过 `dsh-skill-filesystem` 加载：

| 技能 | 用途 |
|---|---|
| `work-research` | 深度调研、来源账本、引用 |
| `work-weekly-report` | 周报/项目周报 |
| `work-meeting-minutes` | 会议纪要、行动项 |
| `work-data-analysis` | 表格分析、图表、可复现 |
| `work-deck` | 10–15 页汇报 PPT |
| `work-doc-polish` | 改写/压缩/统一口径 |

## 格式

每个目录是 `<name>/SKILL.md`，以 YAML frontmatter 开头：

```yaml
---
name: work-research
description: 一句话说明何时使用
whenToUse: 可选，补充触发条件
---
```

DSH 的 `dsh-skill-filesystem` 只扫描根目录顶层的 `<name>/SKILL.md` 或 `<name>.md`，不递归发现。新增/改名/删除会自动进入下一次目录，无需重启。

## 本地挂载

开发期在 profile 的 `cordis.patch.yml` 中把技能根目录加进 `customSkillDirs`：

```yaml
- id: skill-filesystem
  config:
    customSkillDirs:
      - /absolute/path/to/dsh-work/packages/skills-work/skills
```

打包后也可以用 `bundledSkillDir` 指向随包资源。Office 的 7 个技能由 `@deepseek-ai/dsh-skill-office` 提供，不要在这里重复。

## 约定

- 技能正文只写“怎么做”，不写工具 schema。
- Office 产物先调用 `skill(office-docx/pptx/xlsx)`，需要视觉检查时再调用 `skill(office-render)`。
- 所有外部写操作（飞书创建/写入/发消息）默认需要用户确认。
- 交付前用 `present` 声明成果文件。
