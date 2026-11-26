const assert = require('node:assert/strict');
const test = require('node:test');
const invoice = require('../lib/invoice');
const orders = require('../lib/orders');
const pricing = require('../lib/pricing');

function billedOrder(items, coupon = '') {
  const billed = pricing.computeTotals(items, coupon);
  const db = { nextOrderId: 1, orders: [] };
  const order = orders.add(db, { date: '2026-11-26', items, coupon, ...billed });
  return { billed, order };
}

function totals({ subtotal, discount, tax, cgst, sgst, total }) {
  return { subtotal, discount, tax, cgst, sgst, total };
}

test('printable invoice reconciles a mixed-GST order with a capped coupon', () => {
  const { order } = billedOrder([
    { name: 'Rice', hsn: '1006', price: 1400, qty: 1 },
    { name: 'Ghee', hsn: '0405', price: 600, qty: 1 }
  ], 'SAVE10');

  const figures = invoice.computeInvoiceFigures(order);
  assert.equal(figures.total, order.total);
  assert.equal(figures.tax, order.tax);
  assert.equal(figures.discount, 150);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [
    [5, 64.75], [12, 66.6]
  ]);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice matches the stored bill for an undiscounted default-rate item', () => {
  const { order } = billedOrder([{ name: 'Tea', price: 100, qty: 2 }]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.total, order.total);
  assert.equal(figures.tax, order.tax);
  assert.deepEqual(figures, {
    subtotal: 200, discount: 0, tax: 36, cgst: 18, sgst: 18, total: 236,
    rows: [{
      name: 'Tea', sku: '-', hsn: '-', qty: 2, price: 100,
      gstPercent: 18, line: 200, lineTax: 36
    }]
  });
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice applies HSN rates to discounted amounts for saved HSN-only lines', () => {
  const { billed, order } = billedOrder([
    { id: 1, name: 'Rice', hsn: '1006', price: 200, qty: 2 },
    { id: 2, name: 'Ghee', hsn: '0405', price: 200, qty: 1 }
  ], 'FLAT50');
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(totals(billed), {
    subtotal: 600, discount: 50, tax: 40.33, cgst: 20.17, sgst: 20.16, total: 590.33
  });
  assert.deepEqual(billed.lines.map(({ gstPercent, taxable, tax }) => [gstPercent, taxable, tax]), [
    [5, 366.67, 18.33], [12, 183.33, 22]
  ]);
  assert.equal(order.total, 590.33);
  assert.deepEqual(totals(figures), totals(billed));
  assert.deepEqual(figures.rows.map(({ hsn, gstPercent, lineTax }) => [hsn, gstPercent, lineTax]), [
    ['1006', 5, 18.33], ['0405', 12, 22]
  ]);

  const html = invoice.render(order);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">[^<]*40\.33<\/td>/);
  assert.match(html, /Coupon Discount \(FLAT50\)<\/td><td[^>]*>-[^<]*50\.00<\/td>/);
  assert.match(html, /Invoice Total<\/td><td class="r">[^<]*590\.33<\/td>/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice/);
});

test('invoice caps a percentage coupon and calculates GST after the discount', () => {
  const { billed, order } = billedOrder([{ name: 'Tea', price: 2000, qty: 1 }], 'SAVE10');

  assert.deepEqual(totals(billed), {
    subtotal: 2000, discount: 150, tax: 333, cgst: 166.5, sgst: 166.5, total: 2183
  });
  assert.deepEqual(totals(invoice.computeInvoiceFigures(order)), totals(billed));
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice follows billing rules for ineligible and expired coupon codes', () => {
  const items = [{ name: 'Tea', price: 100, qty: 1 }];
  const { order: belowMinimum } = billedOrder(items, 'FLAT50');
  const { order: expired } = billedOrder(items, 'DIWALI20');

  assert.equal(belowMinimum.discount, 0);
  assert.equal(expired.discount, 0);
  assert.equal(invoice.computeInvoiceFigures(belowMinimum).total, 118);
  assert.equal(invoice.computeInvoiceFigures(expired).total, 118);
});

test('invoice honors a saved discount after the original coupon expires', () => {
  const items = [{ name: 'Rice', hsn: '1006', price: 1200, qty: 1 }];
  const order = orders.add({ nextOrderId: 1, orders: [] }, {
    items, coupon: 'DIWALI20', subtotal: 1200, discount: 240, tax: 48, total: 1008
  });
  const figures = invoice.computeInvoiceFigures(order);

  assert.equal(figures.discount, 240);
  assert.equal(figures.rows[0].lineTax, 48);
  assert.equal(figures.total, 1008);
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});

test('invoice honors zero and decimal GST rates', () => {
  const { billed, order } = billedOrder([
    { name: 'Exempt item', price: 100, qty: 1, gstRate: 0 },
    { name: 'Rice', price: 100, qty: 1, gstRate: 0.05 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(billed.lines.map(({ gstPercent, tax }) => [gstPercent, tax]), [[0, 0], [5, 5]]);
  assert.deepEqual(figures.rows.map(({ gstPercent, lineTax }) => [gstPercent, lineTax]), [[0, 0], [5, 5]]);
  assert.equal(order.total, 205);
  assert.equal(figures.total, 205);
});

test('invoice GST total sums the rounded line GST amounts', () => {
  const { billed, order } = billedOrder([
    { name: 'First item', price: 0.1, qty: 1, gstRate: 5 },
    { name: 'Second item', price: 0.1, qty: 1, gstRate: 5 }
  ]);
  const figures = invoice.computeInvoiceFigures(order);

  assert.deepEqual(totals(billed), {
    subtotal: 0.2, discount: 0, tax: 0.02, cgst: 0.01, sgst: 0.01, total: 0.22
  });
  assert.deepEqual(figures.rows.map(({ lineTax }) => lineTax), [0.01, 0.01]);
  assert.deepEqual(totals(figures), totals(billed));
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice/);
});
