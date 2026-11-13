import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    client: 'src/feishu-client.ts',
    auth: 'src/auth.ts',
    approval: 'src/approval.ts',
    share: 'src/share-tools.ts',
    notifier: 'src/notifier.ts',
  },
  format: 'esm',
  outDir: 'lib',
  dts: true,
  clean: true,
  external: [/^@deepseek-ai\//],
  fixedExtension: false,
})
