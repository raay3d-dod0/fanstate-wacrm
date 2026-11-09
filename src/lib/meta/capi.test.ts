import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'

import { buildPurchaseEvent, fbcFromLandingSite } from './capi'
import type { ShopifyOrder } from '@/lib/shopify/orders'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose view of the Meta payload in assertions
type Ev = Record<string, any>

const h = (v: string) => createHash('sha256').update(v).digest('hex')
const NOW = Date.parse('2026-11-09T12:00:00Z')

const order: ShopifyOrder = {
  id: 6100000000001,
  name: '#1003',
  created_at: '2026-11-09T11:00:00Z',
  email: ' Rahul@Example.com ',
  currency: 'INR',
  current_total_price: '2398.00',
  browser_ip: '1.2.3.4',
  client_details: { user_agent: 'Mozilla/5.0' },
  landing_site: '/products/monaco?fbclid=AbC123&utm_source=ig',
  customer: { id: 777, first_name: 'Rahul', last_name: "D'Souza" },
  shipping_address: { phone: '98765 43210', city: 'Bengaluru', zip: '560 001', province_code: 'KA', country_code: 'IN' },
  line_items: [
    { product_id: 11, variant_id: 22, quantity: 2, price: '1199.00', title: 'Monaco' },
    { product_id: 33, variant_id: 44, quantity: 1, current_quantity: 0, price: '99.00', title: 'Removed' },
  ],
}

describe('buildPurchaseEvent', () => {
  it('builds a Purchase with hashed customer details and catalogue ids', () => {
    const e = buildPurchaseEvent(order, {}, NOW) as Ev
    expect(e.event_name).toBe('Purchase')
    expect(e.event_id).toBe('shopify_order_6100000000001')
    expect(e.event_time).toBe(Date.parse('2026-11-09T11:00:00Z') / 1000)
    expect(e.action_source).toBe('website')
    expect(e.user_data).toMatchObject({
      em: h('rahul@example.com'),
      ph: h('919876543210'),
      fn: h('rahul'),
      ln: h('dsouza'),
      ct: h('bengaluru'),
      st: h('ka'),
      zp: h('560001'),
      country: h('in'),
      external_id: h('777'),
      client_ip_address: '1.2.3.4',
      client_user_agent: 'Mozilla/5.0',
    })
    expect(e.user_data.fbc).toMatch(/^fb\.1\.\d+\.AbC123$/)
    expect(e.custom_data).toMatchObject({
      currency: 'INR',
      value: 2398,
      order_id: '#1003',
      content_ids: ['shopify_IN_11_22'],
      num_items: 2,
    })
    expect(e.custom_data.order_channel).toBeUndefined()
  })

  it('tags WhatsApp-chat orders', () => {
    const e = buildPurchaseEvent(order, { whatsappChat: true }, NOW) as Ev
    expect(e.custom_data.order_channel).toBe('whatsapp_chat')
  })

  it('never sends test orders or orders older than 7 days', () => {
    expect(buildPurchaseEvent({ ...order, test: true }, {}, NOW)).toBeNull()
    expect(buildPurchaseEvent({ ...order, created_at: '2026-10-30T00:00:00Z' }, {}, NOW)).toBeNull()
  })

  it('leaves out details the order does not have', () => {
    const e = buildPurchaseEvent({ id: 1, created_at: '2026-11-09T11:00:00Z', email: 'a@b.co' }, {}, NOW) as Ev
    expect(Object.keys(e.user_data).sort()).toEqual(['country', 'em'])
  })
})

describe('fbcFromLandingSite', () => {
  it('reads fbclid from the landing URL', () => {
    expect(fbcFromLandingSite('/?fbclid=XyZ', 1700000000000)).toBe('fb.1.1700000000000.XyZ')
    expect(fbcFromLandingSite('/products/a', 1)).toBeUndefined()
    expect(fbcFromLandingSite(null, 1)).toBeUndefined()
  })
})
