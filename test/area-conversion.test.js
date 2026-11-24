import test from 'node:test';
import assert from 'node:assert/strict';
import { exact, ExactDecimal } from '../src/models/model-utils.js';
import { normalizedEnteredQty, toBaseQuantity, withinApproved } from '../src/shared/utils/conversions.js';

const area = { code: 'M2', areaMm2: '1000000' };
const carton = { code: 'BOX', isCarton: true };
const whole = { baseUnit: 'PIECE', wholeBaseUnits: true };
const f600 = exact('1000000').div(360000).toDecimalPlaces(12, ExactDecimal.ROUND_HALF_UP);

test('area factor is rounded to 12 places', () => assert.equal(f600.toFixed(), '2.777777777778'));

test('PO area and base units cannot exceed the approved base quantity', () => {
  assert.equal(withinApproved('14', '5', f600, '12', false), false);
  assert.equal(withinApproved('12', '4.32', f600, '12', false), true);
  assert.equal(withinApproved('13', '13', '1', '12', false), false);
});

test('PO carton overage allows only the smallest whole carton count that covers the approval', () => {
  assert.equal(withinApproved('28', '7', '4', '28', true), true);
  assert.equal(withinApproved('32', '8', '4', '30', true), true);
  assert.equal(withinApproved('36', '9', '4', '30', true), false);
  assert.equal(withinApproved('32', '8', '4', '28', true), false);
  assert.equal(withinApproved('30', '7.5', '4', '29', true), false);
});

test('normalized area must convert back to the same base quantity at six decimal places', () => {
  assert.equal(normalizedEnteredQty('56', f600, whole, area, '20'), '20.16');
  assert.equal(toBaseQuantity('20.16', f600, whole, area).toFixed(), '56');
  assert.throws(() => normalizedEnteredQty('1', '6', whole, area, '0.1'), /không thể biểu diễn chính xác/);
  assert.equal(normalizedEnteredQty('6', '4', whole, carton, '1.5'), '1.5');
});

test('area units round up to whole pieces on whole-piece products', () => {
  const q = (qty, factor, product = whole, uom = area) => toBaseQuantity(qty, factor, product, uom).toFixed();
  assert.equal(q('100', f600), '278');
  assert.equal(q('0.36', f600), '1');
  assert.equal(q('100.08', f600), '278');
  assert.equal(q('10.1', '4'), '41');
});

test('non-area units and fractional products are not rounded', () => {
  assert.equal(toBaseQuantity('2.5', '3', whole, carton).toFixed(), '7.5');
  assert.equal(toBaseQuantity('100', f600, { ...whole, wholeBaseUnits: false }, area).toFixed(), '277.7777777778');
  assert.equal(toBaseQuantity('1.5', '1', { baseUnit: 'M2', wholeBaseUnits: true }, area).toFixed(), '1.5');
});

test('copyItem keeps qtyBase canonical for area-rounded sources and stays strict otherwise', async () => {
  const { copyItem } = await import('../src/shared/utils/document-copy.js');
  const area = { _id: 'a', lineNo: 1, baseUnitsPerUnit: '2.777777777778', enteredQty: '100', qtyBase: '278' };
  assert.equal(copyItem(area, '278').enteredQty, '100.08');
  assert.equal(copyItem(area, '100').qtyBase, '100');
  assert.equal(copyItem(area, '100').enteredQty, '36');
  const carton = { _id: 'c', lineNo: 1, baseUnitsPerUnit: '3', enteredQty: '2', qtyBase: '6' };
  assert.throws(() => copyItem(carton, '1', {}), /không biểu diễn chính xác/);
  assert.equal(copyItem(carton, '1', { enteredQty: '0.333333' }).enteredQty, '0.333333');
});
