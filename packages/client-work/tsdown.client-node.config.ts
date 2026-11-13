import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { 'client.node': 'src/client/index.tsx' },
  format: 'esm',
  outDir: 'lib',
  dts: false,
  clean: false,
  platform: 'node',
  external: ['react', 'react-dom', 'react/jsx-runtime', /^@deepseek-ai\//],
})
