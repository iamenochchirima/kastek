# Sandwich Baron Website Encyclopedia

Primary website: https://www.sandwichbaron.co.za/
Ordering portal referenced by site: https://sandwichbaronheadoffice.zenfoody.com/newtemplate#/newmenu
Compiled: 2026-02-27
Purpose: AI assistant knowledge base (customer support, ordering guidance, menu discovery, store lookup, pricing snapshot, catering guidance, basic franchising info)

Pricing/source note:
- Core brand, store, catering, and franchise content was crawled from the official Sandwich Baron website
- Menu item and price examples below are aligned to the cleaned menu snapshot already captured in this repo from official Sandwich Baron menu sources
- Client guidance: prices are reportedly updated about once per year, so this encyclopedia can be treated as a static operational snapshot with scheduled review instead of immediate RAG
- Structured link-ready menu data is stored in `sandwichbaron-menu-links.json`

## 1) Brand Overview

Sandwich Baron is a South African sandwich-focused food business and franchise brand.

Core positioning used across the site:
- Freshly made-to-order food
- Free/contactless delivery messaging
- Broad menu (sandwiches, French, footlongs, platters, salads, baked potatoes, wraps, tacos, banting, lunch boxes)
- Catering use cases (office events, weddings, funerals, parties)

History highlights shown on site:
- First store launched in Alberton in May 1996
- Founder listed as Sally J'Arlette-Joy
- Franchise expansion followed in later years

## 2) Ordering Channels

Primary ordering paths:
- Website pages route users to online ordering portal: https://sandwichbaronheadoffice.zenfoody.com/newtemplate
- Store pages often include Uber Eats links for selected branches

AI assistant guidance:
- If user wants to place an order: direct to online ordering first
- If user asks for delivery availability: check nearest store from Stores page
- If user asks for app-based ordering: mention Uber Eats availability depends on branch

## 3) Product Taxonomy

### 3.1 Core Menu Families
- Breakfast
- Sandwiches (3 size formats: Sandwich / French / Footlong)
- Salads
- Baked Potatoes
- Wraps
- Tramezzini
- French Tacos
- Platters (large catering focus)
- Banting options
- Lunch Boxes

### 3.2 Sandwich Structure
The sandwiches page presents prices by 3 size columns:
- Sandwich
- French
- Footlong

Key sandwich notes:
- Bread options listed: white, brown, wholewheat, or health bread
- Sandwiches can be ordered plain or toasted
- French size is listed as 22 cm
- Footlong size is listed as 35 cm
- Avocado and spinach are subject to availability

Representative sandwich pricing examples:
- Chicken Mayo: R47 / R65 / R87
- Chicken Mayo and Avocado: R59 / R82 / R107
- Bacon and Cheese: R47 / R60 / R84
- Steak and Cheese: R60 / R82 / R105
- Tuna Mayo: R45 / R60 / R82

### 3.3 Salad Offering (examples)
- Avocado salad: R64.00
- Biltong and avocado salad: R86.00
- Chicken and avocado salad: R75.00
- Chicken and feta salad: R70.00
- Greek salad: R62.00
- Steak and crumbled feta salad: R76.00
- Dressing choices shown: French, Greek, honey-mustard

### 3.4 Baked Potatoes (examples)
- Plain baked potato with butter: R40.00
- Baked potato and cheese: R57.00
- Baked potato and creamy chicken livers: R64.00
- Baked potato and creamed spinach: R64.00
- Baked potato and mushroom sauce: R64.00
- Baked potato and savoury mince: R64.00
- Baked potato bacon and cheese: R80.00
- Baked potato, spinach and feta: R85.00

### 3.5 Wraps (examples)
- BBQ Chicken & Honey Wrap: R60.00
- BBQ Steak Avocado & Salad Wrap: R78.00
- Chicken mayo, lettuce & avocado wrap: R67.00
- Chicken mayo & salad wrap: R62.00
- Chicken strips, avocado & fried onion wrap: R67.00
- Spicy Tuna Wrap: R62.00

### 3.6 Tramezzini (examples)
- Bacon Chicken Mayo & Cheese Tramezzini: R105
- Bacon Feta & Avocado Tramezzini: R105
- Cheese Tramezzini: R95
- Crispy Bacon & Chicken Mayo Tramezzini: R105
- Tuna Mayo Egg & Tomato Tramezzini: R95
- Chicken Mayo: R85
- Chicken Mayo and Avo: R105
- Ham Cheese and Tomato: R95

### 3.7 Tacos (French Taco category)
- Chicken Taco: R65.00
- Mince Taco: R70.00
- Steak Taco: R77.00
- Steak & Mushroom Taco: R89.00
- Chicken & Bacon Taco: R77.00
- Veg Taco: R60.00

### 3.8 Banting Menu (examples)
- Banting Breakfast Box: R62
- Banting Lunch Box (1): R75
- Banting Lunch Box (2): R75
- Banting Chicken strips: R72
- Banting Omelette: R72
- Banting Veggie Omelette: R68
- Banting Chicken Livers peri-peri: R47
- Banting chicken and avo salad: R75

### 3.9 Lunch Box Menu (examples)
- Deep Fried Spicy Chicken Livers: R67
- Tasty Chicken Boat: R65
- Chicken Wing Lunch Box: R115
- Creamy Chicken Livers Lunch Box: R62
- Spicy Snack Box: R75
- Breakfast Bag: R115
- Healthy Lunch Bag: R62
- Training Lunch Bag 1: R72
- Training Lunch Bag 2: R105

### 3.10 Platter Menu (high-catering relevance)
Representative platter types shown on page:
- All Cheese: R345 (serves 8-10)
- Anytime: R460 (serves 8-10)
- Baroness's sandwich: R370 (serves 8-10)
- Baron Party: R530 (serves 8-10)
- Best of Both: R450
- Director: R620 (serves 8-10)
- Early morning: R490 (serves 10-12)
- Exotic: R640 (serves 8-10)
- Snack: R610 (serves 8-10)
- Summer time fruit: R515 (serves 8-10)
- Sundowner: R700 (serves 6-8)
- Supreme: R460
- Wrap Platter: R470 (serves 8-10)
- Wrap and Sarmie: R425 (serves 8-10)
- Large Wrap Platter: R630 (serves 10-12)
- Vetkoek Feast Platter: R370 (serves 8-10)

Many platter entries include approximate serving guidance (often 8-10 or 10-12) and some note "not available in half size".

### 3.11 Breakfast Snapshot
- Light Breakfast: R55.00
- Vegetarian Breakfast: R57.00
- Bacon and Scrambled Egg Pita: R60.00

## 4) Catering Positioning

Dedicated catering pages and messaging focus on:
- Office and corporate catering
- Wedding and funeral catering
- Party/event platter supply

AI assistant response pattern:
- For events: ask attendee count, dietary needs, delivery area, date/time, budget
- Recommend platter categories + lunch box/banting alternates where needed
- If user asks for the cheapest suitable platter set: offer 2-3 options across value, balanced, and premium ranges

## 5) Store Coverage and Geography

Stores page lists multiple branches, with strongest concentration in Gauteng and additional branches in:
- Klerksdorp
- Middelburg
- Rustenburg

Representative Gauteng branches listed include:
- Alberton
- Boksburg
- Bedfordview
- Bryanston
- Centurion
- Edenvale
- Highveld
- Linbro Park
- Lynnwood
- Midrand
- Randburg
- Roodepoort
- Rivonia
- Sandton

Each store entry typically includes:
- Physical address
- Phone number(s)
- Store email
- Link to order online
- Sometimes Uber Eats link

## 6) Contact and Escalation

Head office contact details shown on Contact page:
- Tel: 011 907 6237 / 010 007 3641
- Fax: 011 869 2923
- Franchising enquiries mobile: 083 287 4745
- Main published email for franchising/complaints/food enquiries: sally@sandwichbaron.com

Site includes contact form fields for:
- Name
- Email
- Phone
- Closest store
- Order details/comments

AI assistant routing logic:
- Order issue at store level: route to nearest store + capture order details
- Brand complaint/escalation: route to head office details above
- Franchise intent: route to franchising contact path

## 7) Franchise Information Snapshot

Franchise section includes:
- Brand history and expansion narrative
- Training/support promises
- FAQ-style investment and operations details

Published figures on page include:
- Delivery store cost: R790,000 + VAT
- Own contribution target for finance: at least 50%
- Royalties: 6% of turnover
- Advertising fund: 2% of turnover
- Typical store size: 80-100 sqm

Note: Site contains mixed historical figures (some sections mention different store counts), so treat franchise numbers as "verify with head office" before quoting as exact.

## 8) Suggested AI Assistant Intent Map

Recommended top intents:
- Find nearest store
- Show menu category
- Compare sandwich sizes (Sandwich vs French vs Footlong)
- Recommend platters by event type and group size
- Delivery/order help
- Dietary requests (banting/lighter options)
- Contact support / complaints
- Franchise enquiry

## 9) Guardrails for Agent Responses

- Use listed prices as a dated menu snapshot suitable for guidance and quoting ranges
- If a user is about to place an order, advise that final checkout/store confirmation is the last source of truth
- Do not promise delivery ETA without store confirmation
- If product availability is uncertain (e.g., avocado/spinach), present as subject to availability
- For franchise financial projections, use "as published on site" and recommend direct confirmation

## 10) Link Handling for Menu Answers

Menu-link policy for the bot:
- If an item exists in `sandwichbaron-menu-links.json`, return the item price together with its `category_url`
- Also include the main order link when the user is clearly trying to buy or continue to checkout
- Do not claim a link is a product-specific page unless a verified product URL has been captured
- For now, treat category pages as the safe clickable reference and the Zenfoody order page as the transactional fallback

Recommended answer pattern:
- "Chicken Mayo is R47 / R65 / R87. You can view the sandwich menu here: https://www.sandwichbaron.co.za/sandwiches and order here: https://sandwichbaronheadoffice.zenfoody.com/newtemplate#/newmenu"

## 11) Maintenance Recommendation

Given the client's note that prices change roughly once per year, a full RAG layer is probably unnecessary for the current Sandwich Baron assistant if the main goal is support and menu guidance.

Practical operating model:
- Keep this encyclopedia as the primary knowledge file
- Refresh menu/pricing on a fixed cadence (for example every 6-12 months, or immediately after client notice of a price update)
- Store a `last_verified_menu_date` in the agent prompt/config so the assistant can disclose when the pricing snapshot was last refreshed
- For high-risk price-sensitive flows, tell users that checkout or the branch confirms the final total

## 12) Firecrawl Scope Rules (to avoid API limit blowups)

Use whitelist-first crawling.

Recommended include regex:
- ^https://www\.sandwichbaron\.co\.za/$
- ^https://www\.sandwichbaron\.co\.za/(stores|takeaway-menu|sandwiches|salads|baked-potatoes|wraps|tacos|party-platters|banting-takeaway-menu|lunch-box-2|tramezzini|funeral-and-wedding-catering|franchising|contact-us)(/)?$

Recommended exclude regex:
- /news/
- /tag/
- /author/
- /\?s=
- /wp-content/
- /feed/
- /comments/
- /specials-2/?$   (currently low-value page)

Operational limits:
- Max depth: 1-2
- Max pages: 20-30
- Ignore external domains except explicit order links you need
- Deduplicate by canonical URL and strip query strings

## 13) Agent-Ready Short Knowledge Snippet

"Sandwich Baron is a South African made-to-order sandwich and platter brand with strong Gauteng coverage and additional branches in Klerksdorp, Middelburg, and Rustenburg. Customers can order via the Sandwich Baron online ordering portal and selected stores on Uber Eats. Main menu families include sandwiches (in sandwich/french/footlong sizes), platters, salads, baked potatoes, wraps, tramezzini, tacos, banting options, lunch boxes, and breakfast items. This knowledge base includes a dated menu-price snapshot that is suitable for guidance because prices reportedly change only about once per year, but final totals should still be confirmed at checkout or with the store. For support, users can contact their nearest store or head office. For franchise enquiries, direct users to the franchising page and head office contacts for latest costs and requirements."
