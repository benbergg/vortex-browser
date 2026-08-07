/**
 * Author: qingwa
 * Description: Keeps a launcher alive while the tested spawn function detaches a hub.
 */
import { trySpawnHub } from "../../src/spawn.js";

const [port, hubEntry, loader] = process.argv.slice(2);
trySpawnHub({
  port: Number(port),
  role: "detached-test",
  hubEntry,
  nodeArgs: ["--experimental-transform-types", "--experimental-loader", loader],
});
setInterval(() => {}, 1_000);
