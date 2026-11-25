import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

const root = await mkdtemp(join(tmpdir(), 'whms-evidence-'));
process.env.EVIDENCE_STORAGE_PROVIDER = 'local';
process.env.EVIDENCE_LOCAL_DIR = root;
const { evidenceStorage } = await import('../src/modules/po-receiving/purchase-evidence.service.js');
test.after(async () => { await rm(root, { recursive: true, force: true }); });

test('local evidence stays private, can be previewed, rejects duplicate keys and cleans up', async () => {
  const bytes = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const key = 'sep490/returns/rehearsal';
  const options = { public_id: key, resource_type: 'image', type: 'authenticated', overwrite: false };
  const uploaded = await evidenceStorage.upload(bytes, options);
  assert.deepEqual(uploaded, { public_id: key, type: 'authenticated' });
  await evidenceStorage.exists(key, 'image');
  const url = await evidenceStorage.download(key, 'png', 'image', Math.floor(Date.now() / 1000) + 60);
  assert.equal(url, `data:image/png;base64,${bytes.toString('base64')}`);
  await assert.rejects(evidenceStorage.upload(bytes, options), error => error.statusCode === 409);
  assert.deepEqual(await evidenceStorage.destroy(key, 'image'), { result: 'ok' });
  assert.deepEqual(await evidenceStorage.destroy(key, 'image'), { result: 'not found' });
  await assert.rejects(evidenceStorage.upload(bytes, { ...options, public_id: '../outside' }), error => error.statusCode === 400);
});
