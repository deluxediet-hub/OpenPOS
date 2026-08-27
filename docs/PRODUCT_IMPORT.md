# OpenPOS Product CSV Import

Download the same template from onboarding or **Management → Products & Pricing → CSV template**.

## Columns

| Column | Required | Meaning |
|---|---:|---|
| `name` | Yes | Brand/product name. Size is appended if not already present. |
| `category` | Yes | Existing or new category name. |
| `size_ml` | Yes | Bottle, serving or keg capacity in millilitres. |
| `selling_unit` | No | `bottle`, `can`, `pack`, `crate`, `carton`, `piece`, `keg`, `kg`, `shot` or `glass`. |
| `price` | Yes | VAT-inclusive selling price in KSh. |
| `cost` | No | Cost in KSh per whole unit; for weighed kegs, cost per kg. Pour cost is derived when zero. |
| `opening_stock` | No | Opening whole-unit quantity, or kg for weighed kegs. |
| `reorder_level` | No | Low-stock threshold in the same stock unit. |
| `sku` | No | Unique shop product code. Required as a source reference when pours are included in the same CSV. |
| `barcode` | No | Unique EAN/UPC barcode. |
| `stock_mode` | No | `unit` (default), `weighed`, or `pour`. |
| `source_sku` | Pour only | SKU of the source bottle or weighed keg. Source rows may appear anywhere in the CSV. |
| `source_size_ml` | Pour only | Full source bottle/keg capacity, e.g. `750` or `20000`. |
| `kra_item_code` | No | KRA/eTIMS item classification code. |
| `tax_type` | No | Tax class; defaults to `B`. |
| `available` | No | `1/yes/true` or `0/no/false`. Weighed sources default to unavailable. |

## Examples

```csv
name,category,size_ml,selling_unit,price,cost,opening_stock,reorder_level,sku,barcode,stock_mode,source_sku,source_size_ml,kra_item_code,tax_type,available
Chrome Vodka,Spirits,250,bottle,450,320,24,6,CHR-250,616000000001,unit,,,,B,1
House Wine Keg,Wine,20000,kg,0,900,20,5,KEG-WINE-20L,,weighed,,,,B,0
House Wine Glass,Wine,150,glass,350,0,0,0,WINE-GLASS-150,,pour,KEG-WINE-20L,20000,,B,1
```

The import is transactional: if any row is invalid, no rows from that file are imported. Maximum size is 2 MB or 2,000 products.
