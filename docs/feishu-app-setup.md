# Feishu app setup

The Feishu integration uses a **self-built Feishu app** and a **user access token**,
so every call runs with the permissions of the person using DSH, not a tenant-wide
robot. You need an app from the Feishu developer console and its `App ID` /
`App Secret`.

## 1. Create the app

1. Open <https://open.feishu.cn/app> and create a self-built app.
2. Under **Credentials & Basic Info**, copy the `App ID` and `App Secret`.
3. Under **Security Settings → Redirect URL**, add:

   ```text
   http://127.0.0.1:17321/feishu/oauth/callback
   ```

   The port is fixed and matches `FEISHU_REDIRECT_URI` in `.env.example`.

If your tenant rejects `http://127.0.0.1` redirects, either terminate a gateway at
`https://<your-domain>/feishu/oauth/callback` and forward the `code`, or use the
manual code prompt: authorize, copy the `code` from the redirect URL, and paste it
into the DSH authorization dialog.

The callback only exchanges `code` for tokens; it validates `state` and uses PKCE.

## 2. Scopes

Enable the scopes that match the capabilities you plan to use, then submit for the
tenant administrator's review.

| Scope | Used by | Purpose |
| --- | --- | --- |
| `docx:document` | `feishu_doc_read`, `feishu_doc_create`, `feishu_doc_append` | read, create and append documents |
| `sheets:spreadsheet` | `feishu_sheet_read`, `feishu_sheet_write`, `feishu_sheet_append` | read and write spreadsheets |
| `drive:drive` | `feishu_drive_upload`, `feishu_share_artifact` | upload artifacts and import docs |
| `wiki:wiki` | `feishu_wiki_get` | resolve a wiki node to its document or sheet |
| `im:message` | `feishu_im_send` | send messages as the user |
| `contact:user.base:readonly` | `feishu_whoami` | current user identity |
| `offline_access` | all tools | refresh token so the connection survives restarts |

Notes:

- The integration never falls back to `tenant_access_token` to read documents; if the
  user lacks access, the API returns a permission error and the tool reports it.
- Scope review usually takes one to four weeks in an enterprise tenant; start it
  before you need the tools.
- `feishu_auth_status` reports an expired grant as disconnected, so you always see
  whether a refresh is needed before a tool call fails.

## 3. Publish and scope availability

1. Create a version under **Version Management & Release** and submit it.
2. After approval, limit **Availability** to a pilot group while testing.
3. Add the bot to a test group if you want `feishu_im_send` card delivery.
4. For direct messages from the bot, the pilot user must be able to see the app.

## 4. Configure DSH

```bash
cp .env.example .env
# fill in FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_REDIRECT_URI
```

For a desktop or shared machine, do not keep the secret in `.env`:

- the app secret and user token live in the DSH credential store under the scope
  `dsh-work-feishu`;
- the desktop app encrypts them with Electron `safeStorage`;
- logs and audit entries record `log_id` only — never tokens, codes, secrets or
  document bodies.

Workbench configuration:

| Key | Meaning |
| --- | --- |
| `accessTokenEnv` | environment variable to read a user token from, if you do not use the OAuth flow |
| `presence` | enables screen/Feishu awareness tools on the host |
| `presenceStyle` | chip appearance: `dsh`, `codex`, `claude` |

## 5. Verify

### App identity (app is reachable)

```bash
curl -sS -X POST 'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal' \
  -H 'Content-Type: application/json' \
  -d "{\"app_id\":\"$FEISHU_APP_ID\",\"app_secret\":\"$FEISHU_APP_SECRET\"}" \
  | jq '{code, msg, expire}'
```

Expect `code: 0`. Do not paste the output anywhere public.

### User OAuth (tools work as you)

1. Open this URL in a browser and approve:

   ```text
   https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=$FEISHU_APP_ID&redirect_uri=$FEISHU_REDIRECT_URI&response_type=code&state=<random>&scope=<urlencoded scopes>
   ```

2. The callback stores the tokens; in a session, run `feishu_whoami` and confirm it
   returns your name.
3. Then try `feishu_sheet_read` on a spreadsheet you can already open in the browser;
   a permission error there means the scope or the document permission is missing,
   not the token.

If a tool returns `feishu_permission_denied`, check the document's sharing
permissions first, then the app scopes. In both cases re-authorize after fixing
scopes: the old token carries the old grant.
