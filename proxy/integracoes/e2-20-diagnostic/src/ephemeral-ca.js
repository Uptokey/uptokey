import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import * as x509 from "@peculiar/x509";

/**
 * Session-scoped CA and leaf certificates generated with Node WebCrypto and
 * @peculiar/x509. Nothing is installed in the operating-system trust store.
 * Private keys live only inside the session directory and destroy() removes
 * them with the rest of that session's material.
 */

const webcrypto = crypto.webcrypto;
const signingAlgorithm = Object.freeze({
  name: "RSASSA-PKCS1-v1_5",
  hash: "SHA-256",
  publicExponent: new Uint8Array([1, 0, 1]),
  modulusLength: 2048,
});

function sha256Pem(pemText) {
  return crypto.createHash("sha256").update(Buffer.from(pemText, "utf8")).digest("hex");
}

function fingerprintOfPemFile(filePath) {
  return sha256Pem(fs.readFileSync(filePath, "utf8"));
}

function pem(label, bytes) {
  const base64 = Buffer.from(bytes).toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${base64}\n-----END ${label}-----\n`;
}

async function privateKeyPem(key) {
  return pem("PRIVATE KEY", await webcrypto.subtle.exportKey("pkcs8", key));
}

async function rsaKeyPair() {
  return webcrypto.subtle.generateKey(signingAlgorithm, true, ["sign", "verify"]);
}

export async function generateSessionCa(sessionDir, { cn = "E2-20-Lab-CA", days = 1 } = {}) {
  fs.mkdirSync(sessionDir, { recursive: true });
  const caKeyPath = path.join(sessionDir, "ca.key");
  const caCertPath = path.join(sessionDir, "ca.crt");
  const notBefore = new Date(Date.now() - 5 * 60_000);
  const notAfter = new Date(Date.now() + days * 24 * 60 * 60_000);
  const caKeys = await rsaKeyPair();
  const caCert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: `CN=${cn}`,
    notBefore,
    notAfter,
    signingAlgorithm,
    keys: caKeys,
    extensions: [
      new x509.BasicConstraintsExtension(true, 1, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyCertSign | x509.KeyUsageFlags.cRLSign, true),
      await x509.SubjectKeyIdentifierExtension.create(caKeys.publicKey, false, webcrypto),
    ],
  }, webcrypto);

  const caPemText = caCert.toString("pem");
  const caKeyPemText = await privateKeyPem(caKeys.privateKey);
  fs.writeFileSync(caCertPath, caPemText, { mode: 0o600 });
  fs.writeFileSync(caKeyPath, caKeyPemText, { mode: 0o600 });
  const fingerprint = fingerprintOfPemFile(caCertPath);

  async function issueLeaf(commonName, outPrefix) {
    const leafKeys = await rsaKeyPair();
    const names = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(commonName)
      ? [{ type: x509.IP, value: commonName }, { type: x509.DNS, value: "localhost" }]
      : [{ type: x509.DNS, value: commonName }, { type: x509.IP, value: "127.0.0.1" }];
    const leafCert = await x509.X509CertificateGenerator.create({
      serialNumber: crypto.randomBytes(16).toString("hex"),
      subject: `CN=${commonName}`,
      issuer: caCert.subject,
      notBefore,
      notAfter,
      signingAlgorithm,
      publicKey: leafKeys.publicKey,
      signingKey: caKeys.privateKey,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature | x509.KeyUsageFlags.keyEncipherment, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension(names),
        await x509.SubjectKeyIdentifierExtension.create(leafKeys.publicKey, false, webcrypto),
      ],
    }, webcrypto);

    const certPemText = leafCert.toString("pem");
    const keyPemText = await privateKeyPem(leafKeys.privateKey);
    const leafCertPath = path.join(sessionDir, `${outPrefix}.crt`);
    const leafKeyPath = path.join(sessionDir, `${outPrefix}.key`);
    fs.writeFileSync(leafCertPath, certPemText, { mode: 0o600 });
    fs.writeFileSync(leafKeyPath, keyPemText, { mode: 0o600 });

    return {
      key: keyPemText,
      cert: certPemText,
      certPath: leafCertPath,
      keyPath: leafKeyPath,
      fingerprint: fingerprintOfPemFile(leafCertPath),
    };
  }

  return {
    caKeyPath,
    caCertPath,
    caPem: Buffer.from(caPemText, "utf8"),
    fingerprint,
    issueLeaf,
    inspect() {
      return {
        fingerprint,
        issuer: cn,
        scope: "session_test_client_only",
        trustState: "ephemeral_uninstalled",
        privateKeyExported: false,
      };
    },
    destroy() {
      for (const file of fs.readdirSync(sessionDir)) {
        try { fs.rmSync(path.join(sessionDir, file), { force: true }); }
        catch { /* best-effort cleanup of session-local material */ }
      }
    },
  };
}
