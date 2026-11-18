import test from 'node:test';
import assert from 'node:assert/strict';
import { openingStockTarget } from '../scripts/setup-opening-stock.mjs';

test('opening setup accepts Atlas only with explicit remote opt-in', () => {
  const uri = 'mongodb+srv://user:password@example.invalid/store';
  assert.throws(() => openingStockTarget(uri), /allow-remote/);
  assert.equal(openingStockTarget(uri, { allowRemote: true }), 'store');
  assert.equal(openingStockTarget('mongodb://localhost:27017/store'), 'store');
  assert.equal(openingStockTarget('mongodb://a.invalid:27017,b.invalid:27017/store?replicaSet=rs', { allowRemote: true }), 'store');
});

test('opening setup requires an explicit application database before connecting', () => {
  for (const uri of [undefined, '', 'mongodb+srv://example.invalid', 'mongodb+srv://example.invalid/', 'mongodb+srv://example.invalid/admin', 'mongodb+srv://example.invalid/local', 'mongodb+srv://example.invalid/config', 'https://example.invalid/store']) {
    assert.throws(() => openingStockTarget(uri, { allowRemote: true }));
  }
});
