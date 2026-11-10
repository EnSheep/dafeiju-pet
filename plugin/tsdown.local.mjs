// 只构建 DSH 插件需要的两份产物（client + host），跳过 standalone / app / chat-panel。
// 原因：chat-panel 这一份在 Windows + pnpm 虚拟存储下会让 rolldown 报
// `Could not load C:Users\lianzhi\...\react\index.js (os error 3)`（盘符后少一个反斜杠），
// 那条链只有独立模式的设置页才用，与 DSH 里的桌宠无关。
import { defineConfig } from 'tsdown';

const shared = {
  format: ['esm'],
  platform: 'node',
  target: 'es2020',
  dts: false,
  outDir: 'lib',
  clean: false,
};

export default defineConfig([
  {
    ...shared,
    entry: { client: 'src/client/index.ts' },
    external: [/^@deepseek-ai\//, /^@electron\//, /^node:/],
    outputOptions: { banner: ';(()=>{', footer: '})();' },
  },
  {
    ...shared,
    entry: { index: 'src/host/index.ts' },
    external: [/^@deepseek-ai\//, /^@electron\//, /^node:/],
  },
]);
