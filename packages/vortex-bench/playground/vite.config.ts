import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  plugins: [vue()],
  server: {
    port: 5173,
    strictPort: true,
    // host: true 绑定所有接口,使 playground 同时可经 localhost 与 127.0.0.1 访问。
    // 这是 E 族 OOPIF(out-of-process iframe)fixture 的基建:parent 在 localhost、
    // child iframe src 指向 127.0.0.1 即构成跨源/跨站 → Chrome site-isolation 下出进程。
    host: true,
  },
});
