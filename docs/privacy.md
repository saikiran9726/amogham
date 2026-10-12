# Data Retention & Privacy Policy

This document details the local data retention, PII protection, and offline storage policies enforced across the Restaurant OS client application (Dexie/IndexedDB) and native runtime.

---

## 1. Local Customer PII Storage

The client application caches customer profiles locally in IndexedDB to enable rapid lookup during order taking in both online and offline operation:
* **Table**: `cachedCustomers`
* **Data Fields**: Customer phone number, name, dietary tags, preferences/notes, visit summary.

### Customer PII Retention Rules
1. **Explicit Logout Purge**:
   When a user signs out via `useAuthStore.logout()`, all records in `cachedCustomers` are wiped immediately via `purgeCustomerPiiAndReceipts({ purgeAll: true })`.
   Furthermore, any customer phone numbers, names, and notes attached to local open order records are anonymized to `null`.
2. **Rolling Retention Threshold**:
   Cached customer records have a default maximum retention period of **7 days**. Records with `updatedAt` timestamps older than the cutoff are automatically purged.

---

## 2. Receipt and Thermal Print Data

* **Table**: `printJobs`
* **Data Fields**: Bill numbers, items ordered, and raw receipt data payloads.

### Receipt Data Scrubbing
1. On session logout, `receiptData` payloads stored inside the `printJobs` queue are cleared to prevent lingering customer purchase history and phone numbers from remaining unencrypted on shared devices.
2. Print jobs older than **7 days** have their raw receipt content automatically scrubbed.

---

## 3. Native Device & Android Security Hardening

1. **Cleartext Restrictions (`network_security_config.xml`)**:
   Cleartext communication (HTTP and raw TCP) is strictly prohibited across public networks. Cleartext traffic is permitted only for:
   * Private IPv4 ranges (RFC 1918 subnets: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`)
   * Loopback (`127.0.0.1`, `localhost`)
   * Local mDNS hostnames (`*.local`) used for ESC/POS thermal LAN printers.
2. **Backup & Transfer Disablement (`data_extraction_rules.xml`)**:
   * `android:allowBackup="false"` prevents extraction via `adb backup` or Google Drive cloud backup.
   * Android 12+ `dataExtractionRules` explicitly excludes application databases, files, and shared preferences from cloud backups and device-to-device migration.
3. **Printer Plugin Sanitation**:
   * All raw printer I/O executes on background thread pools (`Executors.newCachedThreadPool()`).
   * Hostnames and ports are strictly validated against port range (1–65535) and hostname characters.
   * Internal exception traces are never exposed across the JavaScript bridge to prevent memory or sensitive configuration leakage.

---

## 4. Right to Portability & Right to Erasure (DPDP / GDPR)

1. **Customer Data Portability (`GET /customers/:id/export`)**:
   - Authorized restaurant staff with `customer.manage` permission can export a customer's complete data profile as structured JSON.
   - The export includes:
     - Profile metadata (name, phone, email, birthday, dietary preferences, staff notes, consent timestamp).
     - Full order history (order UUIDs, type, status, total in paise, timestamps).
     - Loyalty program records (points balance, tier, lifetime points earned, and complete chronological transaction ledger).
2. **Customer Anonymization (`DELETE /customers/:id`)**:
   - Complies with Right to Erasure without breaking referential integrity on historic financial reporting and receipts.
   - Customer phone number is replaced with an irreversible unique anonymized placeholder (`+910000000000_anonymized_<uuid>`).
   - Customer name, email, birthday, notes, and dietary tags are scrubbed to `null` or empty structures.
   - An immutable audit trail entry (`customer.anonymize`) records the event while omitting the PII from persistent logs.

