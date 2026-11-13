# @dsh-work-plugin/bundle

The bundle that installs DSH Work into a DeepSeek Harness profile: work mode, the
right-side workbench, task artifacts, schedules, Feishu tools and the Feishu
conversation chip.

```bash
dsh plugin add @dsh-work-plugin/bundle
```

Installing the bundle also installs its four parts:

| Package | Role |
| --- | --- |
| `@dsh-work-plugin/host` | work tasks, artifacts, schedules, presence tools |
| `@dsh-work-plugin/client` | workbench panel, composer chip, settings |
| `@dsh-work-plugin/feishu` | Feishu OAuth and 14 Feishu tools |
| `@dsh-work-plugin/skills` | seven bundled work skills |

Requires DeepSeek Harness `>= 0.2.2-rc.2 < 0.3.0`. Restart the app after installing.
The workbench and chip target macOS for screen reading; everything else runs on
Linux and Windows too.

Documentation, screenshots and the setup guide:
<https://github.com/silverze/dsh-work-plugin>

MIT licensed.
