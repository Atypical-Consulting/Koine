# Customers — version 1

## Domain Types

### Email — value object

| Field | Type | Description |
| --- | --- | --- |
| raw | `String` |  |
| normalized | `String` | _derived_ |

**Business rules**
- an email cannot be blank
- invalid email address

### PostalAddress — value object

| Field | Type | Description |
| --- | --- | --- |
| street | `String` |  |
| city | `String` |  |
| postalCode | `String` |  |
| country | `String` |  |
| formatted | `String` | _derived_ |

### LoyaltyTier — enum

Values: Bronze, Silver, Gold

### Customer — entity

Identified by `CustomerId`.

| Field | Type | Description |
| --- | --- | --- |
| name | `String` |  |
| email | `Email` |  |
| shippingAddress | `PostalAddress` |  |
| tier | `LoyaltyTier` |  |
| nickname | `String?` |  |
| phone | `String?` |  |
| displayName | `String` | _derived_ |
| hasPhone | `Bool` | _derived_ |
| segments | `Set<String>` |  |
| freeShipping | `Bool` | _derived_ |

## Specifications

### `IsVip` on `Customer`

Condition: `tier == Gold`

## Services

### `LoyaltyService`

#### Operations

- `discountRate(tier: LoyaltyTier): Decimal`
