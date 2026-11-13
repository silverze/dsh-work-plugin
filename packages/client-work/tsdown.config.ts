import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
  },
  format: 'esm',
  outDir: 'lib',
  dts: true,
  clean: true,
  platform: 'browser',
  external: ['react', 'react-dom', 'react/jsx-runtime', /^@deepseek-ai\//],
  fixedExtension: false,
})
