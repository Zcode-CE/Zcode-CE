/**
 * 自签 CA「完整建链」校验单测（逐 hunk 移植自上游 v4.0.0
 * `packages/desktop/src/main/desktopNetworkPolicy.ts` 的 `verifyCustomCaChain`）。
 *
 * 钉住的契约：设置页 `httpProxyCaCertPath` 配置的证书只补充信任锚，
 * 「请求链里出现过配置的指纹」不再等于放行。旧实现（HEAD 的 :189-195）只要链上任一
 * 证书指纹命中就 ACCEPT_CERTIFICATE，于是把服务端叶证书贴进 CA 文件即可让错域名、
 * 无签发资格、非自签的证书全部通过 —— 锚定证书与建立信任链是两件事。
 *
 * 为什么用桩：node:test 里加载不了真实 electron-updater（见 support/electronUpdaterStub.mjs）；
 * 证书用 node-forge 现场签发。断言只看 verify proc 的回调码：0 = 接受，-3 = 交回 Chromium。
 *
 * fixture 不生成 SKI/AKI：forge 的 `authorityKeyIdentifier: { keyIdentifier: true }` 写入的是
 * 子证书自己的 SKI（node-forge/lib/x509.js:2211 `options.cert.generateSubjectKeyIdentifier()`），
 * 与真实 CA「子证书 AKI = 签发者 SKI」不符，按 AKI 选签发者的建链器会直接找不到路径。
 * 上游 CA 约束验收脚本同样不生成这两个扩展；带 SKI/AKI 的真实链已另行实测（GTS 根可信 ⇒ 通过，
 * 只给叶证书 ⇒ 拒绝）。
 *
 * 运行：cd packages/desktop && mise exec node@24.14.0 -- node --import tsx --test test/desktopNetworkPolicyCaChain.test.ts
 */
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import forge from "node-forge";

register(new URL("./support/stubResolver.mjs", import.meta.url));

const {
  applyDesktopChromiumNetworkPolicies,
  createCustomCaCertificateVerifyProc,
  readCustomCaCertificatesFromPem,
} = await import("../src/main/desktopNetworkPolicy.js");
const { stubAutoUpdater } = await import("./support/electronUpdaterStub.mjs");

const ACCEPT_CERTIFICATE = 0;
const USE_CHROMIUM_DEFAULT_VERIFICATION = -3;
const CERT_AUTHORITY_INVALID = -202;

let nextSerial = 0x1000;
const keyPairs = Array.from({ length: 4 }, () => forge.pki.rsa.generateKeyPair(2048));

interface IssueOptions {
  commonName: string;
  keys: { publicKey: unknown; privateKey: unknown };
  issuer?: { subject: unknown; signingKey: unknown };
  ca?: boolean;
  extensions?: Record<string, unknown>[];
}

function issueCertificate(options: IssueOptions) {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = options.keys.publicKey;
  certificate.serialNumber = (nextSerial += 1).toString(16);
  certificate.validity.notBefore = new Date(Date.now() - 60 * 60 * 1000);
  certificate.validity.notAfter = new Date(Date.now() + 60 * 60 * 1000);
  certificate.setSubject([{ name: "commonName", value: options.commonName }]);
  certificate.setIssuer(options.issuer ? options.issuer.subject : certificate.subject.attributes);
  certificate.setExtensions([
    { name: "basicConstraints", critical: true, cA: options.ca === true },
    {
      name: "keyUsage",
      critical: true,
      digitalSignature: options.ca !== true,
      keyCertSign: options.ca === true,
      cRLSign: options.ca === true,
    },
    ...(options.extensions ?? []),
  ]);
  // forge 的 MessageDigest 是有状态的：同一实例连签多张证书时，只有第一张签名有效，
  // 后续证书会被 WebCrypto/X509 判为验签失败（实测 inter.verify(root.publicKey)=false）。
  certificate.sign(
    options.issuer ? options.issuer.signingKey : options.keys.privateKey,
    forge.md.sha256.create(),
  );
  return certificate;
}

const rootKeys = keyPairs[0]!;
const intermediateKeys = keyPairs[1]!;
const leafKeys = keyPairs[2]!;
const rogueKeys = keyPairs[3]!;

const rootCert = issueCertificate({ commonName: "ZCode Test Root", keys: rootKeys, ca: true });
const intermediateCert = issueCertificate({
  commonName: "ZCode Test Intermediate",
  keys: intermediateKeys,
  ca: true,
  issuer: { subject: rootCert.subject.attributes, signingKey: rootKeys.privateKey },
});
const leafHostname = "update.ca-chain.test";
const leafCert = issueCertificate({
  commonName: leafHostname,
  keys: leafKeys,
  issuer: {
    subject: intermediateCert.subject.attributes,
    signingKey: intermediateKeys.privateKey,
  },
  extensions: [
    { name: "subjectAltName", altNames: [{ type: 2, value: leafHostname }] },
    { name: "extKeyUsage", serverAuth: true },
  ],
});

// 与信任根无关的第二条链：叶证书被用户误当 CA 贴进配置文件时，旧实现会直接放行。
const rogueRootCert = issueCertificate({ commonName: "Rogue Root", keys: rogueKeys, ca: true });
const rogueLeafHostname = "update.rogue.test";
const rogueLeafCert = issueCertificate({
  commonName: rogueLeafHostname,
  keys: leafKeys,
  issuer: { subject: rogueRootCert.subject.attributes, signingKey: rogueKeys.privateKey },
  extensions: [
    { name: "subjectAltName", altNames: [{ type: 2, value: rogueLeafHostname }] },
    { name: "extKeyUsage", serverAuth: true },
  ],
});

interface ChainNode {
  data: string;
  issuerCert?: ChainNode;
}

function certificateChain(...certificates: unknown[]): ChainNode {
  let node: ChainNode | undefined;
  for (const certificate of [...certificates].reverse()) {
    node = {
      data: forge.pki.certificateToPem(certificate),
      ...(node ? { issuerCert: node } : {}),
    };
  }
  return node!;
}

function verifyRequest(hostname: string, errorCode: number, chain: ChainNode) {
  return {
    hostname,
    errorCode,
    certificate: chain,
    validatedCertificate: chain,
    isIssuedByKnownRoot: false,
    verificationResult: errorCode === 0 ? "OK" : "CERT_AUTHORITY_INVALID",
  } as never;
}

async function decide(
  trustedPem: string,
  hostname: string,
  chain: ChainNode,
  errorCode: number = CERT_AUTHORITY_INVALID,
): Promise<number> {
  const verifyProc = createCustomCaCertificateVerifyProc(
    readCustomCaCertificatesFromPem(trustedPem),
  );
  assert.ok(verifyProc, "配置了证书就必须返回证书校验过程");
  return new Promise<number>((done) => {
    verifyProc!(verifyRequest(hostname, errorCode, chain), done);
  });
}

test("叶子证书指纹命中但链上没有信任根 ⇒ 拒绝", async () => {
  const presentedLeafPem = forge.pki.certificateToPem(rogueLeafCert);
  const trustedPem = forge.pki.certificateToPem(rogueLeafCert);
  // 前置事实：请求链里的叶证书就是配置进 CA 文件的那张（指纹逐字相等），
  // 旧实现正是靠这条命中把整条请求放行；新实现必须因为「它不是可信 CA」而拒绝。
  const configured = readCustomCaCertificatesFromPem(trustedPem);
  assert.equal(configured.length, 1);
  assert.equal(configured[0]!.fingerprint256, new X509Certificate(presentedLeafPem).fingerprint256);

  const decision = await decide(
    trustedPem,
    rogueLeafHostname,
    certificateChain(rogueLeafCert, rogueRootCert),
  );
  assert.equal(decision, USE_CHROMIUM_DEFAULT_VERIFICATION);
});

test("链完整且根在信任集合 ⇒ 通过", async () => {
  const decision = await decide(
    forge.pki.certificateToPem(rootCert),
    leafHostname,
    certificateChain(leafCert, intermediateCert, rootCert),
  );
  assert.equal(decision, ACCEPT_CERTIFICATE);
});

test("只接管 CERT_AUTHORITY_INVALID；其它错误码（含 OK）一律交回 Chromium", async () => {
  const chain = certificateChain(leafCert, intermediateCert, rootCert);
  const trustedPem = forge.pki.certificateToPem(rootCert);
  for (const errorCode of [0, -200, -202 + 1]) {
    assert.equal(
      await decide(trustedPem, leafHostname, chain, errorCode),
      USE_CHROMIUM_DEFAULT_VERIFICATION,
      `errorCode=${errorCode}`,
    );
  }
});

test("链可信但主机名不匹配 ⇒ 拒绝", async () => {
  const decision = await decide(
    forge.pki.certificateToPem(rootCert),
    "evil.ca-chain.test",
    certificateChain(leafCert, intermediateCert, rootCert),
  );
  assert.equal(decision, USE_CHROMIUM_DEFAULT_VERIFICATION);
});

test("更新器 Session 与主出口共用同一自定义 CA 策略（第三出口）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zcode-ca-chain-"));
  try {
    const caPath = join(directory, "ca.pem");
    writeFileSync(caPath, `${forge.pki.certificateToPem(rootCert)}\n`);
    const applied = new Map<string, { proxied: boolean; verifyProc: unknown }>();
    const fakeSession = (name: string) => {
      const record = { proxied: false, verifyProc: null as unknown };
      applied.set(name, record);
      return {
        setProxy: async () => {
          record.proxied = true;
        },
        closeAllConnections: async () => {},
        setCertificateVerifyProc: (proc: unknown) => {
          record.verifyProc = proc;
        },
      };
    };
    const provider = {
      defaultSession: fakeSession("default-session"),
      fromPartition: () => fakeSession("embedded-browser"),
    };
    stubAutoUpdater.netSession = fakeSession("auto-updater");

    await applyDesktopChromiumNetworkPolicies(
      provider as never,
      { httpProxyCaCertPath: caPath },
      {
        info: () => {},
        warn: () => {},
      },
    );

    for (const name of ["default-session", "auto-updater", "embedded-browser"]) {
      const record = applied.get(name);
      assert.ok(record?.proxied, `${name} 必须被应用代理策略`);
      assert.ok(record?.verifyProc, `${name} 必须装上自定义 CA 校验过程`);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
