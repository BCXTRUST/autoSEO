import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Template, waitForFile } from "e2b";

const directory = dirname(fileURLToPath(import.meta.url));

export function autoseoBrowserTemplate() {
  return Template({ fileContextPath: directory })
    .fromTemplate("desktop")
    .aptInstall([
      "locales",
      "fonts-dejavu",
      "fonts-liberation",
      "x11-xserver-utils",
      "netcat-openbsd",
    ])
    .runCmd("sed -i 's/# de_DE.UTF-8/de_DE.UTF-8/' /etc/locale.gen && locale-gen", {
      user: "root",
    })
    .runCmd(
      "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs",
      { user: "root" },
    )
    .npmInstall("playwright@1.62.1", { g: true })
    .runCmd("npx -y playwright@1.62.1 install --with-deps chromium", { user: "root" })
    .copy("start.sh", "/opt/autoseo/start.sh", { mode: 0o755, user: "root" })
    .setStartCmd("/opt/autoseo/start.sh", waitForFile("/tmp/autoseo-display-ready"));
}
