import { createHmac } from 'node:crypto'
import { describe, it, expect } from 'vitest'

import {
  verifyShopifyHmac,
  normalizeOrderPhone,
  pickOrderPhone,
  describeLineItems,
  formatOrderTotal,
  cleanTemplateValue,
  orderConfirmedParams,
  type ShopifyOrder,
} from './orders'

describe('verifyShopifyHmac', () => {
  const body = '{"id":1}'
  const secret = 'shh'
  const good = createHmac('sha256', secret).update(body, 'utf8').digest('base64')

  it('accepts the signature Shopify would send', () => {
    expect(verifyShopifyHmac(body, good, secret)).toBe(true)
  })
  it('rejects a changed body, wrong key, or missing header/secret', () => {
    expect(verifyShopifyHmac('{"id":2}', good, secret)).toBe(false)
    expect(verifyShopifyHmac(body, good, 'other')).toBe(false)
    expect(verifyShopifyHmac(body, null, secret)).toBe(false)
    expect(verifyShopifyHmac(body, good, undefined)).toBe(false)
    expect(verifyShopifyHmac(body, 'not-base64!!', secret)).toBe(false)
  })
})

describe('normalizeOrderPhone', () => {
  it.each([
    ['+91 98765 43210', '+919876543210'],
    ['9876543210', '+919876543210'],
    ['09876543210', '+919876543210'],
    ['919876543210', '+919876543210'],
    ['+44 7700 900123', '+447700900123'],
    ['0044 7700 900123', '+447700900123'],
  ])('%s → %s', (raw, want) => {
    expect(normalizeOrderPhone(raw)).toBe(want)
  })
  it.each([null, '', 'abc', '12345'])('rejects %s', (raw) => {
    expect(normalizeOrderPhone(raw as string | null)).toBeNull()
  })
})

describe('pickOrderPhone', () => {
  it('falls back from order phone to shipping, billing, customer', () => {
    expect(pickOrderPhone({ id: 1, shipping_address: { phone: '98765 43210' } })).toBe('+919876543210')
    expect(
      pickOrderPhone({ id: 1, phone: null, customer: { default_address: { phone: '+91 90000 00001' } } }),
    ).toBe('+919000000001')
    expect(pickOrderPhone({ id: 1 })).toBeNull()
  })
})

describe('template values', () => {
  it('lists items with variant and quantity, skipping removed ones', () => {
    expect(
      describeLineItems([
        { title: 'Monaco', variant_title: 'Black / A4', quantity: 1 },
        { title: 'Personalisation', variant_title: 'Default Title', quantity: 1 },
        { title: 'Spa', variant_title: 'White / A3', quantity: 2, current_quantity: 0 },
      ]),
    ).toBe('Monaco (Black / A4) x1, Personalisation x1')
  })

  it('formats rupees the Indian way without .00', () => {
    expect(formatOrderTotal('1199.00', 'INR')).toBe('₹1,199')
    expect(formatOrderTotal('123456.50', 'INR')).toBe('₹1,23,456.50')
  })

  it('flattens new lines and long runs of spaces (WhatsApp rejects them)', () => {
    expect(cleanTemplateValue('a\nb\t c     d')).toBe('a b c d')
    expect(cleanTemplateValue('x'.repeat(10), 5)).toBe('xxxx…')
  })

  it('builds name, order, items, total', () => {
    const order: ShopifyOrder = {
      id: 42,
      name: '#1001',
      currency: 'INR',
      total_price: '1199.00',
      customer: { first_name: 'Rahul' },
      line_items: [{ title: 'Monaco', variant_title: 'Black / A4', quantity: 1 }],
    }
    expect(orderConfirmedParams(order)).toEqual(['Rahul', '#1001', 'Monaco (Black / A4) x1', '₹1,199'])
    expect(orderConfirmedParams({ id: 7 })[0]).toBe('there')
  })
})
