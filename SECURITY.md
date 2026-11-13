# Security policy

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**) instead of opening a public issue.

Include the DSH Work version, the DeepSeek Harness version, your OS, and a
minimal reproduction. You will get an initial reply within a few days.

## What this plugin can access

Be aware of the following before installing:

- **Feishu credentials.** The Feishu integration stores the app credentials you
  enter and the resulting user token in the DeepSeek Harness credential store.
  Tokens never leave your machine, but any code running in the same profile can
  read them.
- **Screen reading (macOS).** When work mode is on, the host compiles a small
  Swift helper and reads the foreground Feishu window with Screen Recording
  permission. OCR runs locally; the recognized text is returned to the current
  session only. Nothing is uploaded by this plugin.
- **Files.** Work tasks write deliverables into the session workspace. Sharing
  to Feishu uploads a file only when you explicitly ask for it in a session.

## Out of scope

- Data you deliberately send to a model provider through a conversation.
- Modifications made by other plugins installed in the same profile.
- Vulnerabilities in DeepSeek Harness or Feishu themselves; report those upstream.
