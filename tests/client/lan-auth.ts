/**
 * Local network carrier — certificate, key-bound sign-in proofs, lockout, discovery filters.
 */
import * as nodeCrypto from "node:crypto";
import * as tls from "node:tls";
import { suite } from "../harness.ts";
import { sleep, waitFor } from "../mocks/lanRig";
import { LanDiscovery, isPrivateIp, vaultTag, type LanDiscoveredDevice } from "../../src/lan-carrier/lanDiscovery";
import { LanLockout, LAN_MIN_KEY_LENGTH, computeProof, generateLanKey, isAcceptableLanKey, randomNonce, verifyProof } from "../../src/lan-carrier/lanAuth";
import { fingerprintOfDer, fingerprintOfPem, formatFingerprint, generateLanCert, isUsableLanCert } from "../../src/lan-carrier/lanCert";

const s = suite("lan-auth");
(globalThis as { window?: unknown }).window ??= globalThis;

s.section("1: the certificate is a real, usable, self-signed ECDSA P-256 certificate");
{
	const cert = generateLanCert("Test");
	const x509 = new nodeCrypto.X509Certificate(cert.certPem);
	s.check(x509.subject.includes("CN=Test"), "the subject is what was asked");
	s.check(x509.checkPrivateKey(nodeCrypto.createPrivateKey(cert.keyPem)), "the key belongs to the certificate");
	s.check(x509.verify(x509.publicKey), "it is signed by its own key");
	s.check(x509.publicKey.asymmetricKeyType === "ec" && x509.publicKey.asymmetricKeyDetails?.namedCurve === "prime256v1", "P-256");
	s.check(new Date(x509.validTo).getTime() > Date.now() + 3000 * 86400_000, "valid for about ten years");
	s.check(cert.fingerprint === formatFingerprint(x509.fingerprint256.replace(/:/g, "")), "our fingerprint equals Node's SHA-256 of the certificate");
	s.check(cert.fingerprint === fingerprintOfPem(cert.certPem) && cert.fingerprint === fingerprintOfDer(x509.raw), "PEM and DER give the same fingerprint");
	s.check(isUsableLanCert(cert.certPem, cert.keyPem), "a stored pair is accepted");
	s.check(!isUsableLanCert(cert.certPem, generateLanCert().keyPem), "a key of another certificate is rejected");
	s.check(!isUsableLanCert(undefined, cert.keyPem) && !isUsableLanCert("junk", "junk"), "missing or damaged material is rejected");
	s.check(!isUsableLanCert(generateLanCert("old", new Date(Date.now() - 4000 * 86400_000)).certPem, cert.keyPem), "an expired certificate is rejected");
	const ctx = (): tls.SecureContext => tls.createSecureContext({ cert: cert.certPem, key: cert.keyPem });
	s.check(typeof ctx() === "object", "TLS accepts it");
	s.check(generateLanCert().fingerprint !== generateLanCert().fingerprint, "every certificate is new");
}

s.section("2: keys: random, long, and no built-in default");
{
	const k = generateLanKey();
	s.check(/^[0-9a-f]{64}$/.test(k) && k !== generateLanKey(), "a generated key is 64 random hex characters");
	s.check(isAcceptableLanKey(k), "a generated key is accepted");
	s.check(!isAcceptableLanKey("default-key") && !isAcceptableLanKey("") && !isAcceptableLanKey(undefined) && !isAcceptableLanKey("a".repeat(LAN_MIN_KEY_LENGTH - 1)), "empty, short, and the old 'default-key' are refused");
	s.check(!isAcceptableLanKey(" ".repeat(40)), "blanks are not a key");
}

s.section("3: proofs bind the key, both nonces, the role and the certificate");
{
	const key = generateLanKey();
	const nc = randomNonce();
	const ns = randomNonce();
	const fp = generateLanCert().fingerprint;
	const proof = computeProof(key, "server", ns, nc, fp);
	s.check(verifyProof(key, "server", ns, nc, fp, proof), "the right inputs verify");
	s.check(!verifyProof(generateLanKey(), "server", ns, nc, fp, proof), "a different key fails");
	s.check(!verifyProof(key, "client", ns, nc, fp, proof), "the proof cannot be replayed for the other role");
	s.check(!verifyProof(key, "server", randomNonce(), nc, fp, proof), "a different server nonce fails (no replay)");
	s.check(!verifyProof(key, "server", ns, randomNonce(), fp, proof), "a different client nonce fails (no replay)");
	s.check(!verifyProof(key, "server", ns, nc, generateLanCert().fingerprint, proof), "another certificate fails — a man in the middle with his own certificate cannot pass");
	s.check(!verifyProof(key, "server", ns, nc, fp, 5) && !verifyProof(key, "server", ns, nc, fp, "short"), "garbage fails without throwing");
	s.check(randomNonce() !== randomNonce() && randomNonce().length === 32, "nonces are random");
}

s.section("4: lockout counts failures per address and expires");
{
	let t = 1_000_000;
	const lock = new LanLockout(5, 300_000, () => t);
	for (let i = 0; i < 4; i++) lock.recordFailure("1.2.3.4");
	s.check(!lock.isLocked("1.2.3.4"), "four failures do not lock");
	lock.recordFailure("1.2.3.4");
	s.check(lock.isLocked("1.2.3.4") && !lock.isLocked("1.2.3.5"), "the fifth locks that address only");
	t += 299_000;
	s.check(lock.isLocked("1.2.3.4"), "still locked just before the end");
	t += 2000;
	s.check(!lock.isLocked("1.2.3.4"), "unlocked after five minutes");
	lock.recordFailure("9.9.9.9");
	lock.recordSuccess("9.9.9.9");
	for (let i = 0; i < 4; i++) lock.recordFailure("9.9.9.9");
	s.check(!lock.isLocked("9.9.9.9"), "a success resets the count");
}

s.section("5: discovery believes only private addresses and the same vault");
{
	s.check(isPrivateIp("192.168.1.5") && isPrivateIp("10.0.0.1") && isPrivateIp("172.16.0.1") && isPrivateIp("172.31.9.9"), "private ranges");
	s.check(!isPrivateIp("172.32.0.1") && !isPrivateIp("8.8.8.8") && !isPrivateIp("127.0.0.1") && !isPrivateIp("fe80::1") && !isPrivateIp("nonsense"), "everything else");
	s.check(vaultTag("v1") === vaultTag("v1") && vaultTag("v1") !== vaultTag("v2") && !vaultTag("v1").includes("v1"), "the vault tag is stable, differs per vault and hides the id");

	const found: LanDiscoveredDevice[] = [];
	const lost: string[] = [];
	const tag = vaultTag("vault-d");
	const a = new LanDiscovery({
		deviceId: "A", deviceName: "A", vault: tag, syncPort: 1111, discoveryPort: 38941,
		onFound: (d) => found.push({ ...d }), onLost: (d) => lost.push(d.deviceId),
		targets: [{ address: "127.0.0.1", port: 38942 }, { address: "127.0.0.1", port: 38944 }], acceptAddress: () => true, canAnnounce: () => true, intervalMs: 100, timeoutMs: 400,
	});
	const b = new LanDiscovery({
		deviceId: "B", deviceName: "B", vault: tag, syncPort: 2222, discoveryPort: 38942,
		onFound: () => undefined, onLost: () => undefined,
		targets: [{ address: "127.0.0.1", port: 38941 }], acceptAddress: () => true, canAnnounce: () => true, intervalMs: 100, timeoutMs: 400,
	});
	const other = new LanDiscovery({
		deviceId: "C", deviceName: "C", vault: vaultTag("another"), syncPort: 3333, discoveryPort: 38943,
		onFound: () => undefined, onLost: () => undefined,
		targets: [{ address: "127.0.0.1", port: 38941 }], acceptAddress: () => true, canAnnounce: () => true, intervalMs: 100, timeoutMs: 400,
	});
	const strict = new LanDiscovery({
		deviceId: "D", deviceName: "D", vault: tag, syncPort: 4444, discoveryPort: 38944,
		onFound: () => undefined, onLost: () => undefined,
		canAnnounce: () => false, intervalMs: 100, timeoutMs: 400,
	});
	await a.start();
	await other.start();
	await strict.start();
	await sleep(350);
	s.check(found.length === 0, "other vaults and loopback (not a private address) are ignored");
	await b.start();
	await waitFor(() => found.length >= 1, 2000);
	s.check(found.length === 1 && found[0]?.deviceId === "B" && found[0].port === 2222 && found[0].address === "127.0.0.1", "the same vault is found with its sync port");
	s.check(a.devices().length === 1 && strict.devices().length === 0, "only A's list has B");
	b.stop();
	await waitFor(() => lost.includes("B"), 3000);
	s.check(lost.includes("B") && a.devices()[0]?.online === false, "a device that stops announcing is marked lost");
	a.stop();
	other.stop();
	strict.stop();
	const quiet = new LanDiscovery({
		deviceId: "Q", deviceName: "Q", vault: tag, syncPort: 5555, discoveryPort: 38945,
		onFound: () => undefined, onLost: () => undefined, canAnnounce: () => false,
		targets: [{ address: "127.0.0.1", port: 38941 }], acceptAddress: () => true, intervalMs: 50,
	});
	const listener = new LanDiscovery({
		deviceId: "L", deviceName: "L", vault: tag, syncPort: 6666, discoveryPort: 38941,
		onFound: (d) => found.push({ ...d }), onLost: () => undefined, canAnnounce: () => false, acceptAddress: () => true,
	});
	await listener.start();
	await quiet.start();
	const before = found.length;
	await sleep(300);
	s.check(found.length === before, "a machine with no private network address does not announce");
	quiet.stop();
	listener.stop();
}
await s.done();
