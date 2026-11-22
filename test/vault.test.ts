import { test } from "node:test";
import assert from "node:assert/strict";
import { exportKey, importKey, open, openWithKey, reseal, seal, WrongPassword, type Secrets } from "../src/lib/vault";

const secrets: Secrets = {
  phrase: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  imported: [],
  accounts: [{ id: "a0", name: "Account 1", kind: "hd", index: 0, address: "11111111111111111111111111111111" }],
  nextIndex: 1,
};

test("the vault opens with the right password only, and refuses tampering", async () => {
  const { blob, key } = await seal(secrets, "correct horse battery");
  assert.equal(blob.kdf.iterations, 600_000);
  assert.ok(!JSON.stringify(blob).includes("abandon"));
  assert.deepEqual((await open(blob, "correct horse battery")).secrets, secrets);
  await assert.rejects(open(blob, "correct horse batterY"), WrongPassword);
  const data = Buffer.from(blob.data, "base64");
  data[5] ^= 1;
  await assert.rejects(open({ ...blob, data: data.toString("base64") }, "correct horse battery"), WrongPassword);

  // The unlocked session keeps the derived key, not the password.
  const again = await importKey(await exportKey(key));
  assert.deepEqual(await openWithKey(blob, again), secrets);

  // Saving a change while unlocked: same password, fresh IV.
  const changed = await reseal(blob, key, { ...secrets, nextIndex: 2 });
  assert.notEqual(changed.iv, blob.iv);
  assert.equal((await open(changed, "correct horse battery")).secrets.nextIndex, 2);
});
