import { describe, it, expect } from 'vitest'

import {
  cartAmount,
  cartCreatedAt,
  cartFirstName,
  cartImageUrl,
  cartPhone,
  describeCartItems,
  resumeIdFromCheckoutUrl,
} from './cart-reminder'

// Shape of the real Fastrr payload received 2026-11-10 (values changed).
const payload = {
  first_name: 'Raayed',
  last_name: 'Mohammed',
  phone_number: '9876543210',
  email: 'R@Example.com',
  created_at: '2026-11-10T10:06:25.746',
  checkout_url: 'https://fanstate.shop/?cart-resume-id=6af29f498163952a22130281&type=report',
  img_url: 'https://cdn.shopify.com/s/files/1/x/top.png',
  items: [{ name: 'Agumbe Ghat - Black / A4', title: 'Agumbe Ghat - Black / A4', img_url: 'https://cdn.shopify.com/s/files/1/x/a.png' }],
  shipping_address: { first_name: 'Raayed', phone: '9876543210' },
}

describe('resumeIdFromCheckoutUrl', () => {
  it('takes the resume id from our own store link', () => {
    expect(resumeIdFromCheckoutUrl(payload.checkout_url)).toBe('6af29f498163952a22130281')
    expect(resumeIdFromCheckoutUrl('https://www.fanstate.shop/?cart-resume-id=abc123')).toBe('abc123')
  })
  it('refuses other sites, plain http, and odd ids', () => {
    expect(resumeIdFromCheckoutUrl('https://evil.example/?cart-resume-id=abc123')).toBeNull()
    expect(resumeIdFromCheckoutUrl('https://fanstate.shop.evil.example/?cart-resume-id=abc123')).toBeNull()
    expect(resumeIdFromCheckoutUrl('http://fanstate.shop/?cart-resume-id=abc123')).toBeNull()
    expect(resumeIdFromCheckoutUrl('https://fanstate.shop/?cart-resume-id=abc%26x%3D1')).toBeNull()
    expect(resumeIdFromCheckoutUrl(null)).toBeNull()
  })
})

describe('cart fields', () => {
  it('reads first name, phone with country code, product and picture', () => {
    expect(cartFirstName(payload)).toBe('Raayed')
    expect(cartPhone(payload, null)).toBe('+919876543210')
    expect(describeCartItems(payload)).toBe('Agumbe Ghat - Black / A4')
    expect(cartImageUrl(payload)).toBe('https://cdn.shopify.com/s/files/1/x/a.png')
  })
  it('names extra items and falls back politely', () => {
    expect(describeCartItems({ items: [{ title: 'A' }, { title: 'B' }, { title: 'C' }] })).toBe('A and 2 more items')
    expect(describeCartItems({})).toBe('Fanstate frame')
    expect(cartFirstName({})).toBe('there')
    expect(cartPhone({}, null)).toBeNull()
  })
  it('only uses pictures from Shopify', () => {
    expect(cartImageUrl({ img_url: 'https://evil.example/a.png' })).toBeNull()
  })
  it('reads Fastrr time as India time', () => {
    expect(cartCreatedAt(payload, '2026-11-10T05:36:28Z').toISOString()).toBe('2026-11-10T04:36:25.746Z')
    expect(cartCreatedAt({}, '2026-11-10T05:36:28Z').toISOString()).toBe('2026-11-10T05:36:28.000Z')
  })
})

describe('cartAmount', () => {
  it('formats the cart total in rupees', () => {
    expect(cartAmount({ total_price: 1199, currency: 'INR' })).toBe('₹1,199')
    expect(cartAmount({ total_price: '2877.6' })).toBe('₹2,877.60')
  })
})
