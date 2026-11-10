// 桌宠应用构建配置（tsdown.pet.mjs）
//
// 与 tsdown.config.mjs 的差别有两处：
//   1) **不含 chat-panel 那份**。它把 react/react-dom 内联，在 Windows + pnpm 虚拟存储下
//      rolldown 会报 `Could not load C:Users\lianzhi\...\react\index.js (os error 3)`
//      （盘符后少一个反斜杠），一条链失败会带走整次构建。那份产物只服务「独立模式设置页
//      里的对话面板」，与桌宠本体（透明窗口 + 待机动画 + 说话）无关。
//   2) **不 import { defineConfig } from 'tsdown'**。本机 pnpm 布局下 tsdown 是 junction，
//      配置文件里 import 'tsdown' 会让 jiti 以 CJS 再加载一次 tsdown，而它内部的 debug
//      在 junction 路径的向上查找里解析不到，直接 `Cannot find module 'debug'` 整次构建失败。
//      defineConfig 只是类型包装，去掉它导出纯对象即可，产物完全一样。
//
// 产出四份：
//   lib/client.js     —— 浏览器半侧（宠物 overlay + 设置页插槽）
//   lib/index.js      —— 宿主半侧（DSH 插件入口，保持 ESM）
//   lib/standalone.js —— 独立模式 CLI（伪 ctx + 本机 HTTP 服务，无窗口）
//   lib/app.js        —— 单进程桌面应用（本机服务 + 宿主半边 + Electron 透明窗口）
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 本配置文件所在目录（= 包根） */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)));

/** 替换包名用的绝对路径（rolldown 的 alias 收绝对路径最稳） */
const shim = (name) => join(packageRoot, 'src', 'standalone', 'shims', `${name}.ts`);

/** 三份配置共用的编译口径 */
const shared = {
  format: ['esm'],
  platform: 'node',
  target: 'es2020',
  dts: false,
  outDir: 'lib',
  clean: false,
};

/** 三个「只在 DSH 里存在」的包 → 本地替身 */
const shimAlias = {
  '@deepseek-ai/dsh-home-paths': shim('dsh-home-paths'),
  '@deepseek-ai/dsh-credentials': shim('dsh-credentials'),
  '@deepseek-ai/dsh-llm': shim('dsh-llm'),
};

export default [
  {
    ...shared,
    entry: {
      client: 'src/client/index.ts',
    },
    external: [/^@deepseek-ai\//, /^@electron\//, /^node:/],
    // 浏览器半侧必须能被**重复执行**：DSH 把 lib/client.js 当经典脚本加载，重试/HMR 会让
    // 同一文件在同一页面里再执行一次，顶层 const/let 会直接 SyntaxError。包一层 IIFE 躲开。
    outputOptions: { banner: ';(()=>{', footer: '})();' },
  },
  {
    ...shared,
    entry: {
      index: 'src/host/index.ts',
    },
    external: [/^@deepseek-ai\//, /^@electron\//, /^node:/],
  },
  {
    ...shared,
    target: 'es2022',
    entry: {
      standalone: 'src/standalone/cli.ts',
    },
    noExternal: [/^@deepseek-ai\/(?:dsh-home-paths|dsh-credentials|dsh-llm)$/],
    external: [/^@electron\//, /^node:/, /^@deepseek-ai\/(?!dsh-home-paths$|dsh-credentials$|dsh-llm$)/],
    alias: shimAlias,
  },
  {
    ...shared,
    target: 'es2022',
    entry: {
      app: 'src/app/main.ts',
    },
    // ⚠ 与上游 tsdown.config.mjs 的关键差异：zod / openai / @anthropic-ai\/sdk / edge-tts
    // **不内联**，保持外部裸 import。上游内联它们是为了做出「不依赖 node_modules」的发行包，
    // 但在这台机器上那条路会撞同一个 rolldown 路径 bug：
    //   Could not load C:Users\lianzhi\...\node_modules\.pnpm\zod@4.6.7\node_modules\zod\index.js
    // （`C:\Users` 的盘符后反斜杠被吃掉 → os error 3），四份内联包全炸。
    // 本机开发跑（scripts/start-app.mjs）cwd 就在包根，node_modules 在场，外部化完全够用。
    // 等要出 portable exe 时再回来处理这条（候选：把依赖装到非 .pnpm 的平铺目录）。
    noExternal: [/^@deepseek-ai\/(?:dsh-home-paths|dsh-credentials|dsh-llm)$/],
    external: ['electron', /^@electron\//, /^node:/, /^@deepseek-ai\/(?!dsh-home-paths$|dsh-credentials$|dsh-llm$)/],
    alias: shimAlias,
  },
];
