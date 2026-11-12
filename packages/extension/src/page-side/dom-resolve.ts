// Page-side module：把穿 open shadow 的查询暴露给 dom.ts / content.ts 的 inline func。
// 普通 files 注入保持原有幂等行为；observe 使用带原请求 lease 的自包含函数。
import { installDomResolve } from "./dom-resolve-install.js";

installDomResolve();
