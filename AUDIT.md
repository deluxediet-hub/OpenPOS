# Serengeti POS — Market Readiness Audit

**Date:** 24 August 2026 · **Scope:** full-stack review + competitive/regulatory research
**Verdict: NOT market-ready to sell in Kenya.** Excellent pilot for one venue. Three blockers, one of them legal.

---

## 1. Bottom line

| Question | Answer |
|---|---|
| Can you run your own restaurant on it today? | **Yes**, at one venue, with caveats below |
| Can you sell it to other Kenyan restaurants? | **No** — not until eTIMS is done |
| Can you take real M-Pesa? | **No** — the STK button is a prompt, not an integration |
| Is the core POS logic sound? | **Yes** — 193 automated tests, tax maths independently checked |

The engineering is genuinely good. The **compliance and integration layer is absent**, and in Kenya
that layer is not optional.

---

## 2. The blocking issue: KRA eTIMS

This is the one that stops a sale. I searched the codebase for `etims|tims|vscu|cuin|control unit|qr`:

```
(no matches)
```

There is **zero** eTIMS code. Our receipt prints a static KRA PIN field from settings and nothing else.

### Why this is disqualifying

eTIMS is KRA's mandatory electronic invoicing system. Every business in Kenya must issue invoices
through it — **not just VAT-registered ones** [1](https://www.cuteprofit.com/blog/etims-in-kenya-2026-guide-registration-requirements).

For restaurants specifically:

> Every VAT-registered restaurant and hospitality business in Kenya must issue eTIMS-compliant
> invoices for every sale — including cash sales, card payments, and mobile money transactions...
> non-compliance attracts a penalty of **KES 50,000 per month**
> — [smartvatkenya.co.ke](https://smartvatkenya.co.ke/resources/vat-for-restaurants-hospitality/)

Other sources put non-compliance penalties as high as **KES 1,000,000 or three years
imprisonment** [2](https://eliteteqpos.com/ke/blog/kra-etims-pos-setup-guide-kenya/).

The enforcement landscape tightened again: from **1 January 2026** KRA validates income and expenses
declared in tax returns against eTIMS data, and expenses without an eTIMS invoice are disallowed
[3](https://europe.thomsonreuters.com/compliance/regulatory-updates/kenya).

### What a compliant receipt needs that ours lacks

Per KRA requirements [4](https://betasuiteerp.com/blog/kra-etims-compliance-guide-kenya):

| Required on receipt | We have it? |
|---|---|
| Business name, address, KRA PIN | ✅ |
| Sequential invoice number | ✅ (order number) |
| Itemised lines with quantity, price, **tax classification** | ⚠️ lines yes, tax classification **no** |
| VAT broken out | ✅ |
| **eTIMS control number (CUIN) returned by KRA** | ❌ |
| **KRA QR code for verification** | ❌ |
| **Real-time transmission to KRA** | ❌ |
| Buyer PIN for B2B above KES 50,000 | ❌ |

### The integration path

Three options exist; only one suits a POS [4](https://betasuiteerp.com/blog/kra-etims-compliance-guide-kenya):

1. **Portal** — manual entry per invoice. Impractical at a busy bar.
2. **TIMS Client** — Windows app, still manual.
3. **VSCU API** (Virtual Sales Control Unit) — POS talks directly to KRA, invoice transmitted as
   it's raised, CUIN returned and printed. **This is what we'd build.**

Practical notes: KRA allows a **48-hour window** for offline invoice submission, so a queued-and-retry
design is acceptable. Every menu item needs a KRA item classification code — that's a data-entry job
on the 87 seeded items.

**Effort estimate:** 2–4 weeks including KRA sandbox testing and item classification.

---

## 3. Blocker two: M-Pesa is not integrated

Searched for `daraja|safaricom|stkpush|consumer_key|passkey`:

```
(no matches)
```

The "Send STK push" button in the payment modal sets a text label. That's it. A cashier could type
any string into the confirmation field and close the bill.

### What real integration requires

Per Safaricom's Daraja documentation and community guides
[5](https://dev.to/msnmongare/how-to-go-live-with-m-pesa-daraja-api-production-environment-4h96)
[6](https://www.mctaba.com/learn/africa/mpesa-integration-guide):

- Daraja account, Consumer Key/Secret, an approved **Paybill or Till number**
- **Publicly reachable HTTPS callback URL** — Safaricom will not post to a LAN address or localhost.
  A venue running this on a local network needs a tunnel, a public IP, or a cloud relay.
- **IP whitelisting** by Safaricom before production endpoints open
- Sandbox first: shortcode `174379`, test number `254708374149`
- Go-live letter and business KYC; approval takes 2–5 business days

### The trap most integrations get wrong

> This response only means Safaricom received the request. It does **NOT** mean the customer has paid.
> — [questdesigners.com](https://www.questdesigners.com/blog/mpesa-integration-to-website)

You must store the `CheckoutRequestID`, wait for the callback, and handle it **idempotently** —
Safaricom retries. Our current design records a payment the instant the cashier clicks confirm,
which is the opposite of safe. That needs restructuring, not just wiring.

**Effort estimate:** 1–2 weeks, plus the callback-hosting problem.

---

## 4. Blocker three: security is demo-grade

Verified by grep, not assumed:

```
rate.?limit|attempts|throttle|lockout  →  (no matches)
https.|createServer|tls|cert           →  (no matches)
```

| Issue | Impact |
|---|---|
| **PINs stored in plain text** | Anyone with the DB file has every staff PIN |
| **No rate limiting on `/api/login`** | A 4-digit PIN is 10,000 combinations. Scriptable in seconds. |
| **No HTTPS** | Sessions and PINs cross the LAN in clear text |
| **In-memory sessions** | Restart signs everyone out mid-service |
| **Audit log not tamper-evident** | Anyone with DB access can delete their own voids |
| **No session expiry** | A logged-in tablet stays logged in forever |

The rate-limiting gap is the worst — it makes PIN auth decorative. Fixing all of this is roughly a
week and should precede any sale.

---

## 5. Feature gaps vs. the market

I checked each against the codebase, then against what Kenyan and international competitors offer.

### Confirmed missing (grep returned nothing)

| Feature | Why it matters | Competitors |
|---|---|---|
| **Happy hour / daypart pricing** | Core to a **lounge**. Time-based pricing is table stakes. | Toast, TouchBistro, Lavu |
| **Open bar tabs / card pre-auth** | A lounge without bar tabs loses money | Toast, TouchBistro |
| **Reservations / table booking** | Front-of-house planning | Lightspeed, JiPOS |
| **Modifiers & variant groups** | We have free-text notes only — no priced size/topping options | Nearly all |
| **Loyalty / gift cards / coupons** | Retention; big in Nairobi F&B | Toast, Loyverse, Square |
| **Staff clock-in / shift management** | Labour cost is ~30% of revenue | Toast, Revel, Kappino |
| **Cash drawer float & reconciliation** | We have a Z-report but no expected-vs-counted | All serious systems |
| **Multi-location** | Blocks any chain customer | JiPOS, SimbaPOS, Revel |
| **QR table ordering** | Rising expectation post-2020 | Kappino, Menew |
| **Delivery aggregation** | Uber Eats / Bolt Food orders land outside the POS | Toast, Revel |

### The inventory finding — verified, not assumed

I ran a live test: sold 2× Nyama Choma and 1× Grilled Tilapia (KSh 3,300), paid it in cash, then
re-read stock.

```
BEFORE -> Beef 42 kg | Tilapia 20 kg
PAID   -> order closed | KSh 3300.00 for 2x Nyama Choma + 1x Tilapia
AFTER  -> Beef 42 kg | Tilapia 20 kg

CONFIRMED: stock did NOT move.
```

There is no recipe/BOM link, so **selling never depletes stock**. The inventory module is currently
a manual ledger, not stock control. Every competitor claims real-time ingredient tracking.
For a venue buying KSh 500k of stock a month, this is the difference between a POS and a till.

### Printing — the quiet practical problem

Receipts go through `window.print()`. There is no ESC/POS driver, no cash-drawer kick, and no
kitchen printer routing. Real venues run 80mm thermal printers and expect the drawer to pop on a
cash sale. Workable for a pilot, not for daily service.

### What we do well

Being fair — some things are genuinely competitive:

- **Local-first architecture.** SQLite on-premise means service continues with no internet. That's
  a real selling point in Kenya, and it's the same design the free "Timeline Restaurants POS" uses
  as a headline feature [7](https://timelinedigi.com/blog/cheapest-pos-system-for-restaurant-complete-cost-guide-usa-2026).
  Cloud POS systems fail here.
- **Tax maths is correct and tested**, including the subtle Kenyan rule that a *mandatory* service
  charge is VATable while a *free* tip is not — we compute VAT on `net + service` and add tips
  outside the taxable base. That matches KRA guidance
  [8](https://smartvatkenya.co.ke/resources/vat-for-restaurants-hospitality/).
- **Server-side cash change** that can't be doctored in the browser.
- **Role-based permissions enforced server-side**, with manager-PIN re-auth for sensitive actions.
- **193 automated tests**, including a jsdom suite that drives the real client bundle.

---

## 6. Competitive landscape

**Kenyan hospitality POS** — all lead with eTIMS compliance and M-Pesa:

- **NomadPOS** (Saliq) — purpose-built for Kenyan restaurants, bars, nightclubs; eTIMS-compliant,
  table service, kitchen coordination, mobile money [9](https://saliq.co.ke/top-5-pos-systems-in-kenya-2025-best-solutions-for-restaurants-retail-more/)
- **SimbaPOS** — retail/restaurant/hotel, positioned on affordability [10](https://www.simbapos.co.ke/)
- **JiPOS / iOSoft** — unlimited users, multi-store, room booking, hotel ERP
- **Chakula Chetu, AfriPOS, RobiPOS, LinearPOS**

**International:** Toast, TouchBistro (~$69/terminal/month), Square, Lightspeed, Revel, Oracle MICROS,
Lavu, SambaPOS [11](https://www.softwaresuggest.com/restaurant-pos-software/kenya)

**Read-across:** the entry ticket in this market is *eTIMS + M-Pesa + thermal printing*. We have none
of the three. Our differentiator — offline-first, no subscription, own-your-data — is real, but it's
a secondary argument until the compliance table is cleared.

---

## 7. Prioritised roadmap

### Phase 1 — Legally sellable (4–6 weeks)
1. **eTIMS VSCU integration** — transmit on sale, print CUIN + QR, 48h offline queue, item
   classification codes on all menu items
2. **M-Pesa Daraja STK push** — with pending/callback state machine and idempotency, not
   confirm-on-click
3. **Security** — hash PINs (argon2), rate-limit login with lockout, session expiry, HTTPS

### Phase 2 — Operationally viable (3–4 weeks)
4. **Recipe/BOM stock depletion** — makes inventory real
5. **ESC/POS printing** — thermal receipts, kitchen tickets, drawer kick
6. **Cash drawer reconciliation** — open float, expected vs counted, variance report
7. **Happy hour / daypart pricing** — essential for the lounge side

### Phase 3 — Commercially competitive (4–6 weeks)
8. Open bar tabs with card pre-auth
9. Modifiers and variant groups
10. Staff clock-in, shift reports, labour cost
11. Reservations
12. Loyalty and gift cards

### Phase 4 — Scale
13. Multi-location, delivery aggregation, QR ordering, cloud sync/backup

---

## 8. Honest verdict

**As a product to sell: not ready.** Phase 1 is non-negotiable — a Kenyan restaurant buying a POS
without eTIMS is buying a KES 50,000/month liability, and any competent buyer will ask on the first
call.

**As a system to run your own venue: usable now**, if you accept manual eTIMS via the KRA portal or
mobile app for invoicing, keep M-Pesa as a manual till-number flow where the cashier keys in the
confirmation code, and change the default PINs.

**What I'd genuinely say to a buyer today:** "This is a solid, offline-first, subscription-free POS
with correct Kenyan tax handling. It is not yet eTIMS-certified or Daraja-integrated." Selling it
without that disclosure would be selling someone a compliance problem.

---

### Sources

1. cuteprofit.com — eTIMS Guide Kenya 2026
2. eliteteqpos.com — KRA eTIMS POS Setup Guide
3. Thomson Reuters — Kenya regulatory updates
4. betasuiteerp.com — KRA eTIMS Compliance Guide
5. dev.to/msnmongare — Daraja production go-live
6. mctaba.com — M-Pesa Daraja Integration Guide 2026
7. timelinedigi.com — Restaurant POS Cost Guide
8. smartvatkenya.co.ke — VAT for Restaurants & Hospitality Kenya
9. saliq.co.ke — Top 5 POS Systems in Kenya
10. simbadpos.co.ke
11. softwaresuggest.com — Restaurant POS Kenya

*Regulatory detail is drawn from vendor and advisory publications, not primary KRA legislation.
Confirm current requirements and penalties with KRA or a tax adviser before relying on them.*
