#!/usr/bin/env node
/*
 * Fail if anything about to be published looks account-specific, internal or secret.
 * Scans every file git would commit (tracked plus new, not ignored).
 *
 *   npm run check-publishable
 *
 * Allowed on purpose: AWS-owned public Lambda layer accounts, listed below with why.
 */
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

const RULES = [
    { name: "12-digit AWS account ID", re: /(?<![\d.])\d{12}(?![\d.])/g },
    { name: "access key ID", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
    { name: "secret access key assignment", re: /aws_secret_access_key\s*[=:]\s*\S+/gi },
    { name: "private key block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
    { name: "internal host", re: /\b[\w.-]*\.(aws\.dev|amazon\.dev|corp\.amazon\.com|a2z\.com)\b|\bmidway(-auth)?\.|\bmwinit\b/gi },
    { name: "internal marking", re: /Amazon (Internal|Confidential)/gi },
    { name: "AWS CLI profile", re: /--profile\s+\S+|AWS_PROFILE\s*=\s*\S+/g },
    { name: "Discord bot token", re: /\b[MN][A-Za-z\d]{23,25}\.[\w-]{6}\.[\w-]{27,38}\b/g },
];

const ALLOWED = new Set([
    "336392948345", // AWS-owned publisher of the "AWS SDK for pandas" Lambda layer (BackendStack.ts)
]);

const SKIP = [/(^|\/)package-lock\.json$/, /\.(png|jpe?g|gif|webp|ico|pdf|zip)$/i];

const files = execSync("git ls-files --cached --others --exclude-standard", { cwd: ROOT, encoding: "utf8" })
    .split("\n").filter(Boolean).filter((f) => !SKIP.some((s) => s.test(f)));

const hits = [];
for (const rel of files) {
    const full = path.join(ROOT, rel);
    if (!fs.existsSync(full) || fs.statSync(full).size > 2 * 1024 * 1024) continue;
    const lines = fs.readFileSync(full, "utf8").split("\n");
    lines.forEach((line, i) => {
        for (const rule of RULES) {
            for (const m of line.matchAll(rule.re)) {
                if (ALLOWED.has(m[0])) continue;
                hits.push(`${rel}:${i + 1}  [${rule.name}]  ${line.trim().slice(0, 140)}`);
            }
        }
    });
}

if (hits.length) {
    console.error(`check-publishable: ${hits.length} finding(s):\n` + hits.join("\n"));
    process.exit(1);
}
console.log(`check-publishable: OK (${files.length} files scanned)`);
