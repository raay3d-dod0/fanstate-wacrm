import { describe, it, expect } from 'vitest'

import { fastrrRequestAuthorized, parseAbandonedCart } from './abandoned-cart'

const req = (headers: Record<string, string>, url = 'https://crm.example/api/fastrr/abandoned-cart') =>
  new Request(url, { method: 'POST', headers })

describe('fastrrRequestAuthorized', () => {
  it('accepts the key as Bearer or a custom header', () => {
    expect(fastrrRequestAuthorized(req({ authorization: 'Bearer s3cret' }), 's3cret')).toBe(true)
    expect(fastrrRequestAuthorized(req({ key: 's3cret' }), 's3cret')).toBe(true)
    expect(fastrrRequestAuthorized(req({ 'x-api-key': 's3cret' }), 's3cret')).toBe(true)
  })
  it('rejects a wrong or missing key, and an unset secret', () => {
    expect(fastrrRequestAuthorized(req({ key: 'nope' }), 's3cret')).toBe(false)
    expect(fastrrRequestAuthorized(req({}), 's3cret')).toBe(false)
    expect(fastrrRequestAuthorized(req({}, 'https://crm.example/x?key=s3cret'), 's3cret')).toBe(false)
    expect(fastrrRequestAuthorized(req({ key: 's3cret' }), undefined)).toBe(false)
  })
})

describe('parseAbandonedCart', () => {
  it('pulls the usual fields from nested payloads', () => {
    const c = parseAbandonedCart({
      cart_id: 'abc123',
      customer: { first_name: 'Raayed', last_name: 'Mohammed', phone: '9876543210', email: 'r@x.co' },
      cart: { total_price: '2877.60' },
      links: { checkout_url: 'https://checkout.example/cart/abc123' },
    })
    expect(c).toEqual({
      cartId: 'abc123',
      phone: '+919876543210',
      customerName: 'Raayed Mohammed',
      email: 'r@x.co',
      total: 2877.6,
      checkoutUrl: 'https://checkout.example/cart/abc123',
    })
  })
  it('copes with an empty or unexpected payload', () => {
    expect(parseAbandonedCart({})).toMatchObject({ cartId: null, phone: null, total: null })
    expect(parseAbandonedCart(null)).toMatchObject({ phone: null })
  })
  it('takes the shopper name, not the product title in items[].name', () => {
    const c = parseAbandonedCart({
      cart_id: 'c1',
      first_name: 'Raayed',
      last_name: 'Mohammed',
      phone_number: '9876543210',
      items: [{ name: 'Agumbe Ghat - Black / A4' }],
    })
    expect(c.customerName).toBe('Raayed Mohammed')
    expect(c.phone).toBe('+919876543210')
  })
})
