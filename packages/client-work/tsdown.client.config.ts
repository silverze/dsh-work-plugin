import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { client: 'src/client/index.tsx' },
  format: 'cjs',
  outDir: 'lib/.client',
  dts: false,
  clean: true,
  platform: 'browser',
  external: ['react', 'react-dom', 'react/jsx-runtime', /^@deepseek-ai\//],
})
