import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('./admin', () => ({
  shopifyAdminConfigured: vi.fn(() => true),
  shopifyGraphql: vi.fn(),
}))

import { shopifyGraphql } from './admin'
import {
  parseOrderNumber,
  orderPhoneMatches,
  describeOrder,
  lookupOrderForContact,
  type LookupOrder,
} from './order-lookup'

const base: LookupOrder = {
  name: '#1003',
  cancelledAt: null,
  displayFulfillmentStatus: 'UNFULFILLED',
  phone: null,
  shippingAddress: { phone: '098765 43210' },
  billingAddress: null,
  fulfillments: [],
}

describe('parseOrderNumber', () => {
  it.each([
    ['#1003', '1003'],
    ['1003', '1003'],
    ['order no 1003 please', '1003'],
    ['# 1003', '1003'],
  ])('%s → %s', (t, n) => expect(parseOrderNumber(t)).toBe(n))
  it.each(['', 'hi', '#12', null])('rejects %s', (t) => expect(parseOrderNumber(t as string | null)).toBeNull())
})

describe('orderPhoneMatches', () => {
  it('matches whatever format the checkout phone was typed in', () => {
    expect(orderPhoneMatches(base, '919876543210')).toBe(true)
    expect(orderPhoneMatches(base, '+91 98765 43210')).toBe(true)
  })
  it('refuses a different number or no number', () => {
    expect(orderPhoneMatches(base, '919000000000')).toBe(false)
    expect(orderPhoneMatches(base, null)).toBe(false)
  })
})

describe('describeOrder', () => {
  it('unshipped → confirmed', () => {
    const r = describeOrder(base)
    expect(r.status).toBe('confirmed')
    expect(r.answered).toBe(true)
    expect(r.reply).toContain('#1003 is confirmed')
  })
  it('shipped → courier and tracking link', () => {
    const r = describeOrder({
      ...base,
      fulfillments: [
        {
          status: 'SUCCESS',
          displayStatus: 'IN_TRANSIT',
          deliveredAt: null,
          createdAt: '2026-11-10T05:00:00Z',
          trackingInfo: [{ company: 'Delhivery', number: 'DL123', url: 'https://t.example/DL123' }],
        },
      ],
    })
    expect(r.status).toBe('shipped')
    expect(r.reply).toContain('Courier: Delhivery')
    expect(r.reply).toContain('https://t.example/DL123')
    expect(r.trackingUrl).toBe('https://t.example/DL123')
  })
  it('delivered → date', () => {
    const r = describeOrder({
      ...base,
      fulfillments: [
        { status: 'SUCCESS', displayStatus: 'DELIVERED', deliveredAt: '2026-11-12T09:00:00Z', createdAt: '2026-11-10T05:00:00Z', trackingInfo: [] },
      ],
    })
    expect(r.status).toBe('delivered')
    expect(r.reply).toContain('delivered on 12 Nov')
  })
  it('cancelled → not answered, goes to a person', () => {
    const r = describeOrder({ ...base, cancelledAt: '2026-11-10T05:00:00Z' })
    expect(r.status).toBe('cancelled')
    expect(r.answered).toBe(false)
  })
})

describe('lookupOrderForContact', () => {
  beforeEach(() => vi.mocked(shopifyGraphql).mockReset())

  it('answers when the phone matches', async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({ orders: { nodes: [base] } })
    const r = await lookupOrderForContact('#1003', '919876543210')
    expect(r.status).toBe('confirmed')
    expect(vi.mocked(shopifyGraphql).mock.calls[0][1]).toEqual({ q: 'name:#1003' })
  })
  it('does not reveal someone else\'s order', async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({ orders: { nodes: [base] } })
    const r = await lookupOrderForContact('#1003', '919000000000')
    expect(r).toMatchObject({ status: 'phone_mismatch', answered: false, reply: null })
  })
  it('not found / bad number / Shopify down → hand to a person', async () => {
    vi.mocked(shopifyGraphql).mockResolvedValue({ orders: { nodes: [] } })
    expect((await lookupOrderForContact('#9999', '919876543210')).status).toBe('not_found')
    expect((await lookupOrderForContact('hello', '919876543210')).status).toBe('invalid_number')
    vi.mocked(shopifyGraphql).mockResolvedValue({ orders: null } as never) // broken Shopify reply
    expect((await lookupOrderForContact('#1003', '919876543210')).status).toBe('error')
  })
})
