# Frontend Production Bundle & Performance Report

## 1. Overview & Optimization Goals
- **Target Main Chunk**: $< 250\text{ kB}$ gzip.
- **Architectural Changes**:
  - Service worker transitioned from static unmanaged file to Workbox PWA with `registerType: 'prompt'`.
  - Deferred PWA update prompt when cart or outbox is non-empty.
  - Route code-splitting with `React.lazy` across all 20+ Owner Portal child views (`OwnerHome`, `OwnerStaff`, `OwnerSales`, `OwnerExpenses`, `OwnerHealth`, etc.).
  - Vendor chunk grouping (`vendor-react`, `vendor-icons`, `vendor-db`).

---

## 2. Before vs. After Chunk Distribution

### Baseline (Prior Monolithic Bundles)
- Single monolithic Owner Portal + Application bundle: **502.30 kB minified / 151.42 kB gzip**.
- Main index bundle: **399.37 kB minified / 77.09 kB gzip**.

### Post-Optimization (Split & Vendor Isolated)
| Chunk Name | Size (Uncompressed) | Size (Gzip) | Purpose |
| :--- | :--- | :--- | :--- |
| `index-CfMqcSJn.js` (Main Shell) | **229.32 kB** | **62.52 kB** | Primary application shell & navigation (well below 250 kB gzip target) |
| `vendor-react-VqgVZkOE.js` | **165.09 kB** | **53.98 kB** | React, React DOM, React Router DOM |
| `index-DL72yjNP.js` | **115.99 kB** | **34.06 kB** | Kitchen portal bundle |
| `vendor-db-LH5efVz5.js` | **96.46 kB** | **32.44 kB** | Dexie IndexedDB engine |
| `vendor-icons-Jx5xs__A.js` | **48.96 kB** | **9.81 kB** | Lucide icon glyphs |
| `BillHistoryView-CCVkgMGb.js` | **35.27 kB** | **9.95 kB** | Bill history & search module |
| `OwnerMonthReview-BIEYQlsv.js` | **33.90 kB** | **7.39 kB** | Owner monthly review module |
| `OwnerInventory-BvBDqKzF.js` | **33.79 kB** | **7.14 kB** | Inventory & supplier management |
| `OwnerCloseDay-BSnIeSWv.js` | **30.82 kB** | **6.52 kB** | Day close reconciliation |
| `OwnerExpenses-CD-jVLM6.js` | **29.67 kB** | **5.92 kB** | Expense tracker |
| `OwnerCustomers-B6XDw-0s.js` | **28.95 kB** | **6.84 kB** | Customer profiles |
| `OwnerHealth-CUI5gLNh.js` | **28.22 kB** | **7.00 kB** | Health scores & analytics |
| `OwnerLoyalty-B2Wx0CiC.js` | **28.09 kB** | **5.91 kB** | Loyalty tiers & point rules |
| `OwnerMenu-3VgjKhvz.js` | **25.02 kB** | **6.78 kB** | Menu editor |
| `OwnerSales-Bh1s8aoj.js` | **24.67 kB** | **5.89 kB** | Sales reports |
| Individual dialogs/components | **0.46–14.29 kB** | **0.25–4.29 kB** | Micro-chunks dynamically loaded on demand |

**Result**: Largest main chunk is **62.52 kB gzip** ($< 250\text{ kB}$ threshold met).

---

## 3. Accessibility & Security Compliance
- **Axe Accessibility**: Audited with `axe-core` across notification prompts, banners, and modals (`wcag2a`, `wcag2aa`). Zero serious or critical violations.
- **XSS Protection**: Zero instances of `dangerouslySetInnerHTML` or raw unescaped receipt HTML strings in source.
- **Data Protection**: Local customer PII and receipt payloads purged automatically on logout and via 7-day retention threshold.
