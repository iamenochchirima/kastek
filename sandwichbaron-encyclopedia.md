# Sandwich Baron Website Encyclopedia

Source website: https://www.sandwichbaron.co.za/
Compiled: 2026-02-26
Purpose: AI assistant knowledge base (customer support, ordering guidance, menu discovery, store lookup, basic franchising info)

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

Representative fillings include:
- Chicken mayo variants
- Bacon-and-egg variants
- Beef, steak, ham, salami variants
- Tuna mayo variants
- Vegetarian/cheese/avocado combinations

### 3.3 Salad Offering (examples)
- Avocado salad
- Chicken and avocado salad
- Chicken and feta salad
- Greek salad
- Crispy bacon salad
- Dressing choices shown: French, Greek, honey-mustard

### 3.4 Baked Potatoes (examples)
- Plain butter
- Cheese
- Bacon and cheese
- Creamy chicken livers
- Mushroom sauce
- Savoury mince
- Spinach & feta

### 3.5 Wraps (examples)
- BBQ chicken & honey
- BBQ steak avocado & salad
- Chicken mayo + salad/avocado variants
- Crumbed chicken & salad
- Spicy tuna
- Omelette-style wraps with bacon/cheese or spinach/cheese/avocado

### 3.6 Tramezzini (examples)
- Bacon chicken mayo & cheese
- Bacon feta & avocado
- Crispy bacon & chicken mayo
- Tuna mayo egg & tomato
- Ham cheese and tomato

### 3.7 Tacos (French Taco category)
- Chicken taco
- Mince taco
- Steak taco
- Steak & mushroom taco
- Chicken & bacon taco
- Veg taco

### 3.8 Banting Menu (examples)
- Banting breakfast box
- Banting lunch boxes
- Banting chicken strips
- Banting omelette variants
- Banting chicken/greek salad add-ons
- Add-ons include biltong and fruit options

### 3.9 Lunch Box Menu (examples)
- Deep fried spicy chicken livers lunch box
- Tasty chicken boat
- Chicken wing lunch box
- Creamy chicken livers lunch box
- Spicy snack box
- Breakfast bag
- Healthy lunch bag
- Mixed snack lunch box options

### 3.10 Platter Menu (high-catering relevance)
Representative platter types shown on page:
- All Cheese
- Anytime
- Baroness's sandwich
- Baron Party
- Best of Both
- Breakfast
- Businessman's sandwich
- Cheese and biscuit
- Chicken
- Chicken Delight
- Cocktail
- Cold meat fantasy
- Director
- Early morning
- Exotic
- Go Bokke platter
- Health
- Just sausage rolls

Many platter entries include approximate serving guidance (often 8-10 or 10-12) and some note "not available in half size".

## 4) Catering Positioning

Dedicated catering pages and messaging focus on:
- Office and corporate catering
- Wedding and funeral catering
- Party/event platter supply

AI assistant response pattern:
- For events: ask attendee count, dietary needs, delivery area, date/time, budget
- Recommend platter categories + lunch box/banting alternates where needed

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

- Do not promise exact prices unless recently verified at checkout/store level
- Do not promise delivery ETA without store confirmation
- If product availability is uncertain (e.g., avocado/spinach), present as subject to availability
- For franchise financial projections, use "as published on site" and recommend direct confirmation

## 10) Firecrawl Scope Rules (to avoid API limit blowups)

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

## 11) Agent-Ready Short Knowledge Snippet

"Sandwich Baron is a South African made-to-order sandwich and platter brand with strong Gauteng coverage and additional branches in Klerksdorp, Middelburg, and Rustenburg. Customers can order via the Sandwich Baron online ordering portal and selected stores on Uber Eats. Main menu families include sandwiches (in sandwich/french/footlong sizes), platters, salads, baked potatoes, wraps, tramezzini, tacos, banting options, and lunch boxes. For support, users can contact their nearest store or head office. For franchise enquiries, direct users to the franchising page and head office contacts for latest costs and requirements."

