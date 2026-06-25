# TalentTrust Backend API Documentation

## Overview

The TalentTrust Backend API provides RESTful endpoints for managing escrow contract metadata. This API follows a modular architecture with proper separation of concerns, authentication, validation, and comprehensive error handling.

## Base URL

```
http://localhost:3001/api/v1
```

## Authentication

The API uses Bearer token authentication. Include the token in the Authorization header:

```
Authorization: Bearer <token>
```

### Demo Tokens
- `demo-admin-token` - Admin user with full access
- `demo-user-token` - Regular user with limited access

## Contract Metadata API

### Overview

Contract metadata allows storing key-value pairs associated with escrow contracts. Metadata can be marked as sensitive for data protection.

### Data Types

Supported data types for metadata values:
- `string` - Text values (default)
- `number` - Numeric values
- `boolean` - True/false values
- `json` - JSON objects/arrays

### Endpoints

#### Create Metadata

**POST** `/contracts/{contractId}/metadata`

Creates a new metadata record for a contract.

**Request Body:**
```json
{
  "key": "string",
  "value": "string",
  "data_type": "string|number|boolean|json",
  "is_sensitive": "boolean"
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "contract_id": "uuid",
  "key": "string",
  "value": "string",
  "data_type": "string",
  "is_sensitive": "boolean",
  "created_by": "uuid",
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

**Error Responses:**
- `401` - Authentication required
- `400` - Validation failed
- `404` - Contract not found
- `409` - Metadata key already exists for this contract

#### List Metadata

**GET** `/contracts/{contractId}/metadata`

Retrieves paginated metadata records for a contract with optional filtering.

**Query Parameters:**
- `page` (number, default: 1) - Page number for pagination
- `limit` (number, default: 20, max: 100) - Items per page
- `key` (string) - Filter by metadata key
- `data_type` (string) - Filter by data type

**Response (200):**
```json
{
  "records": [
    {
      "id": "uuid",
      "contract_id": "uuid",
      "key": "string",
      "value": "string",
      "data_type": "string",
      "is_sensitive": "boolean",
      "created_by": "uuid",
      "created_at": "ISO8601",
      "updated_at": "ISO8601"
    }
  ],
  "total": 10,
  "page": 1,
  "limit": 20
}
```

**Error Responses:**
- `401` - Authentication required
- `400` - Invalid parameters

#### Get Single Metadata

**GET** `/contracts/{contractId}/metadata/{id}`

Retrieves a specific metadata record by ID.

**Response (200):**
```json
{
  "id": "uuid",
  "contract_id": "uuid",
  "key": "string",
  "value": "string",
  "data_type": "string",
  "is_sensitive": "boolean",
  "created_by": "uuid",
  "updated_by": "uuid",
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

**Error Responses:**
- `401` - Authentication required
- `404` - Metadata not found

#### Update Metadata

**PATCH** `/contracts/{contractId}/metadata/{id}`

Updates an existing metadata record. Only mutable fields can be updated.

**Request Body:**
```json
{
  "value": "string",
  "is_sensitive": "boolean"
}
```

**Response (200):**
```json
{
  "id": "uuid",
  "contract_id": "uuid",
  "key": "string",
  "value": "string",
  "data_type": "string",
  "is_sensitive": "boolean",
  "created_by": "uuid",
  "updated_by": "uuid",
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

**Error Responses:**
- `401` - Authentication required
- `400` - Attempting to update immutable fields
- `404` - Metadata not found

#### Delete Metadata

**DELETE** `/contracts/{contractId}/metadata/{id}`

Soft deletes a metadata record. The record is marked as deleted but retained in the database.

**Response (204):** No content

**Error Responses:**
- `401` - Authentication required

## Sensitive Data Protection

Metadata marked as `is_sensitive: true` is automatically masked for unauthorized users:

- **Owners** (users who created the metadata) can see the actual value
- **Admins** can see all sensitive values
- **Other users** see `***REDACTED***` instead of the actual value

## Validation Rules

### Key Validation
- Required field
- 1-255 characters
- Only alphanumeric characters, underscores, and hyphens allowed
- Regex: `^[a-zA-Z0-9_-]+$`

### Value Validation
- Required field
- 1-10,000 characters

### Data Types
- Must be one of: `string`, `number`, `boolean`, `json`
- Defaults to `string` if not specified

## Pagination

### Cursor-Based Pagination (Contracts List — recommended)

The `GET /api/v1/contracts` endpoint uses **cursor-based pagination**.  Unlike
offset pagination this approach is O(log n) — it does not degrade as the
dataset grows and it never skips or duplicates rows when records are inserted
between requests.

#### Query Parameters

| Parameter | Type   | Default | Constraints          | Description                                      |
|-----------|--------|---------|----------------------|--------------------------------------------------|
| `limit`   | number | `20`    | 1–100 (inclusive)    | Maximum items to return in one page.             |
| `cursor`  | string | —       | opaque base-64 token | Pagination cursor from the previous page's `nextCursor`. Omit on the first page. |

#### Response Shape

```json
{
  "status": "success",
  "data": {
    "data": [
      {
        "id": "uuid",
        "title": "string",
        "status": "PENDING",
        "createdAt": "ISO8601"
      }
    ],
    "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI0LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6InV1aWQifQ",
    "hasNextPage": true,
    "limit": 20
  }
}
```

- `nextCursor` is `null` when the current page is the last page.
- `hasNextPage` is `true` when `nextCursor` is non-null.
- The cursor is opaque — do not attempt to parse or construct it manually.

#### Traversal Example

```bash
# First page (no cursor)
curl "http://localhost:3001/api/v1/contracts?limit=10" \
  -H "Authorization: Bearer demo-user-token"

# Next page (use nextCursor from previous response)
curl "http://localhost:3001/api/v1/contracts?limit=10&cursor=<nextCursor>" \
  -H "Authorization: Bearer demo-user-token"
```

#### Ordering

Results are ordered by `createdAt DESC`, with `id DESC` as a tie-breaker when
two contracts share an identical timestamp.  This ordering is stable — adding
new contracts does not change the position of existing items relative to each
other.

#### Error Responses

- `400 Bad Request` — `limit` exceeds 100, is non-positive, or `cursor` is malformed.

### Legacy Offset Pagination (Metadata endpoints)

Metadata list endpoints still use offset-based pagination:

| Parameter | Type   | Default | Constraints | Description          |
|-----------|--------|---------|-------------|----------------------|
| `page`    | number | `1`     | > 0         | Page number.         |
| `limit`   | number | `20`    | 1–100       | Items per page.      |

```json
{
  "records": [...],
  "total": 100,
  "page": 1,
  "limit": 20
}
```

## Error Handling

All endpoints return consistent error responses:

```json
{
  "error": "Error message",
  "details": [
    {
      "field": "field.name",
      "message": "Validation error message"
    }
  ]
}
```

### Common Error Codes
- `400` - Bad Request (validation errors, invalid parameters)
- `401` - Unauthorized (missing or invalid authentication)
- `404` - Not Found (resource doesn't exist)
- `409` - Conflict (duplicate key, resource conflict)
- `422` - Unprocessable Entity (business logic violations)
- `500` - Internal Server Error

## Examples

### Creating Metadata

```bash
curl -X POST http://localhost:3001/api/v1/contracts/123/metadata \
  -H "Authorization: Bearer demo-user-token" \
  -H "Content-Type: application/json" \
  -d '{
    "key": "contract_amount",
    "value": "10000.00",
    "data_type": "number",
    "is_sensitive": true
  }'
```

### Listing Metadata with Filters

```bash
curl -X GET "http://localhost:3001/api/v1/contracts/123/metadata?page=1&limit=10&data_type=number" \
  -H "Authorization: Bearer demo-user-token"
```

### Updating Metadata

```bash
curl -X PATCH http://localhost:3001/api/v1/contracts/123/metadata/456 \
  -H "Authorization: Bearer demo-user-token" \
  -H "Content-Type: application/json" \
  -d '{
    "value": "15000.00"
  }'
```

### Deleting Metadata

```bash
curl -X DELETE http://localhost:3001/api/v1/contracts/123/metadata/456 \
  -H "Authorization: Bearer demo-user-token"
```

## Health Check

**GET** `/health`

Returns the health status of the API service.

**Response (200):**
```json
{
  "status": "ok",
  "service": "talenttrust-backend"
}
```

## Development

### Running Tests

```bash
npm test
```

### Starting Development Server

```bash
npm run dev
```

### Building for Production

```bash
npm run build
npm start
```
